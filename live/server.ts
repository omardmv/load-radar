// Live mode: one always-on process with the whole loop, fresh data every start. Two threads, two cores:
//   world thread (live/world-worker.ts): new loads forever -> simulated boards (:7001) and Telegram (:7002), live answer key
//   main thread (this file): engine (poll boards over HTTP, dedup, match, alert to Telegram over HTTP) + API + UI
//
//   node live/server.ts --port 8080 --gliner http://gliner2:7100 --otlp http://otel-collector:4318/v1/traces
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import client from 'prom-client';
import { createAdjustableClock } from '../src/shared/clock.ts';
import { BOARDS, type SearchSpec, type User, type Equip } from '../src/shared/types.ts';
import { toUser } from '../src/data/users.ts';
import { startEngine } from '../src/engine.ts';
import { createWorld } from '../sim/world.ts';
import { createPlaceIndex } from '../src/parse/places.ts';
import { parseSearch } from '../src/parse/parse.ts';
import { createGlinerExtractor } from '../src/parse/gliner.ts';
import { describe } from '../src/parse/normalize.ts';
import type { ModelCall } from '../src/parse/types.ts';
import { setupLlmTracing } from '../src/obs/llm.ts';
import { setupLogs } from '../src/obs/log.ts';
import type { ToWorld, WorldInit } from './world-worker.ts';
import { runAgent, warmAgent, type AgentMode } from '../src/agent/agent.ts';
import { decide, type AgentLoad, type Facts, type Truck } from '../src/agent/policy.ts';
import { milesBetween } from '../src/shared/geo.ts';

const { values: a } = parseArgs({ options: {
  port: { type: 'string', default: '8080' }, speed: { type: 'string', default: '1' }, 'loads-per-day': { type: 'string', default: '20000' },
  users: { type: 'string', default: '300' }, seed: { type: 'string', default: '' }, budget: { type: 'string', default: '60' },
  gliner: { type: 'string', default: 'http://127.0.0.1:7100' }, otlp: { type: 'string', default: 'off' }, 'metrics-port': { type: 'string', default: '9464' },
  state: { type: 'string', default: 'data/live' }, 'dedup-model': { type: 'string', default: '' },
  ollama: { type: 'string', default: 'http://127.0.0.1:11434' }, 'agent-model': { type: 'string', default: 'qwen2.5:3b-instruct' }, 'agent-mode': { type: 'string', default: 'hybrid' } } });

const here = dirname(fileURLToPath(import.meta.url));
// Traces: one per API request (every step, the model's input and output) -> collector -> Tempo; model spans also -> Langfuse.
// Logs: one JSON line per event -> stdout and collector -> Loki, carrying the trace id.
const otlp = a.otlp === 'off' ? null : a.otlp!;
const tracing = setupLlmTracing({ endpoint: otlp, serviceName: 'load-radar-live' });
const { log } = setupLogs({ endpoint: otlp ? otlp.replace(/\/v1\/traces$/, '/v1/logs') : null, serviceName: 'load-radar-live' });
const span = async <T>(name: string, attrs: Record<string, string | number | boolean>, fn: (s: Span | null) => Promise<T> | T): Promise<T> => {
  if (!tracing.tracer) return fn(null);
  return tracing.tracer.startActiveSpan(name, { attributes: attrs }, async (s) => {
    try { return await fn(s); } catch (e) { s.recordException(e as Error); s.setStatus({ code: SpanStatusCode.ERROR, message: String(e) }); throw e; } finally { s.end(); }
  });
};
const YOU = 'you';
const seed = a.seed ? Number(a.seed) : (Date.now() & 0x7fffffff);       // new world every start unless pinned
const clock = createAdjustableClock({ simStart: Date.now(), speed: Number(a.speed) });
const world = createWorld(seed);

// ---------- users: synthetic dispatchers + you (searches saved across restarts) ----------
mkdirSync(a.state!, { recursive: true });
const youFile = join(a.state!, 'you.json');
type SavedSearch = { spec: SearchSpec; text: string; summary: string; createdAt: number };
const saved: SavedSearch[] = existsSync(youFile) ? JSON.parse(readFileSync(youFile, 'utf8')) : [];
const you: User = { userId: YOU, credentials: BOARDS.map((b) => ({ credentialId: `you-${b}`, userId: YOU, board: b })), searches: saved.map((s) => s.spec) };
const users: User[] = [you, ...Array.from({ length: Number(a.users) }, (_, i) => toUser(world.makeUser(i + 1)))];
const createdAt = new Map(saved.map((s) => [s.spec.searchId, s.createdAt]));     // synthetic searches: since forever
const persist = () => writeFileSync(youFile, JSON.stringify(saved, null, 1));

// ---------- UI event stream (server-sent events) ----------
const clients = new Set<ServerResponse>();
const send = (event: string, data: unknown) => { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
const recentPostings: unknown[] = [];
const recentAlerts: unknown[] = [];
const ring = (xs: unknown[], x: unknown, n: number) => { xs.unshift(x); if (xs.length > n) xs.pop(); };

// ---------- the world thread ----------
type Score = { expected: number; delivered: number; missed: number; missedOpen5Min: number; duplicates: number; unexpected: number; backfill: number; late: number; cancelled: number; missRate: number; latencySec: { p50: number | null; p95: number | null; p99: number | null } };
type WorldStats = { world: { loads: number; postings: number; perBoard: Record<string, number>; scheduled: number }; boards: { ok: number; rejected: number; bannedRequests: number; bannedLogins: number };
  score: { all: Score; you: Score; pending: number }; loadsPerDay: number; loopP99Ms: number };
const zero: Score = { expected: 0, delivered: 0, missed: 0, missedOpen5Min: 0, duplicates: 0, unexpected: 0, backfill: 0, late: 0, cancelled: 0, missRate: 0, latencySec: { p50: null, p95: null, p99: null } };
let ws: WorldStats = { world: { loads: 0, postings: 0, perBoard: {}, scheduled: 0 }, boards: { ok: 0, rejected: 0, bannedRequests: 0, bannedLogins: 0 },
  score: { all: zero, you: zero, pending: 0 }, loadsPerDay: Number(a['loads-per-day']), loopP99Ms: 0 };
const init: WorldInit = { seed, anchor: clock.anchor(), loadsPerDay: Number(a['loads-per-day']), budget: Number(a.budget), users, createdAt: [...createdAt], watch: YOU };
const worldThread = new Worker(new URL('./world-worker.ts', import.meta.url), { workerData: init });
const toWorld = (m: ToWorld) => worldThread.postMessage(m);
worldThread.on('error', (e) => { log('error', 'world.crashed', { error: String(e) }); process.exit(1); });   // container restarts
const factsWaiting = new Map<number, (x: { load: (AgentLoad & { origin_lat: number; origin_lon: number }) | null; market: number | null }) => void>();
let factsReq = 0;
const loadFacts = (loadId: string) => new Promise<{ load: (AgentLoad & { origin_lat: number; origin_lon: number }) | null; market: number | null }>((resolve) => {
  const reqId = ++factsReq; factsWaiting.set(reqId, resolve); toWorld({ type: 'loadFacts', reqId, loadId });
  setTimeout(() => { if (factsWaiting.delete(reqId)) resolve({ load: null, market: null }); }, 5_000);
});
await new Promise<void>((resolve) => worldThread.on('message', (m) => {
  if (m.type === 'ready') resolve();
  else if (m.type === 'loadFacts') { factsWaiting.get(m.reqId)?.(m); factsWaiting.delete(m.reqId); }
  else if (m.type === 'stats') ws = m;
  else if (m.type === 'postings') { for (const x of m.postings) ring(recentPostings, x, 60); send('postings', m.postings); }
  else if (m.type === 'alert') {
    ring(recentAlerts, m.alert, 100);
    send('alert', m.alert);
    for (const x of m.alert.loads) log('info', 'alert.sent', { user: YOU, load_id: x.loadId, latency_sec: x.latencySec ?? undefined, expected: x.expected, late: x.late, backfill: x.backfill, text: m.alert.lines.join(' | ') });
  }
}));
const engine = await startEngine({ users, boardsUrl: 'http://127.0.0.1:7001', telegramUrl: 'http://127.0.0.1:7002', clock, budgetPerMin: Number(a.budget),
  connectionsPerBoard: 64, metricsPort: Number(a['metrics-port']) || null, otlpEndpoint: a.otlp === 'off' ? null : a.otlp!, sampleRate: 0.01, maxUsers: 0, bots: 4, dedupModel: a['dedup-model'] || null });

setInterval(() => exportScore(), 5_000);

// ---------- answer-key metrics for the SLOs (SLO.md), scraped by Prometheus at live:8080/metrics ----------
// The live scorer keeps totals; Prometheus wants counters, so each sweep adds the change since the last one.
const reg = new client.Registry();
const settled = new client.Counter({ name: 'answer_key_settled_total', registers: [reg], labelNames: ['outcome'],
  help: 'expected alerts that settled: delivered, missed_open (load stayed 5+ min: our fault), missed_quick (taken within 5 min)' });
const other = new client.Counter({ name: 'answer_key_other_total', registers: [reg], labelNames: ['kind'],
  help: 'deliveries outside the answer key: late (after the 15 min cutoff), duplicate, unexpected, backfill' });
new client.Gauge({ name: 'answer_key_pending', registers: [reg], help: 'expected alerts not settled yet', collect() { this.set(ws.score.pending); } });
new client.Gauge({ name: 'world_eventloop_lag_p99_seconds', registers: [reg], help: 'event-loop delay p99 of the world thread (boards, Telegram, answer key)', collect() { this.set(ws.loopP99Ms / 1000); } });
let last = { delivered: 0, missedOpen: 0, missedQuick: 0, late: 0, duplicates: 0, unexpected: 0, backfill: 0 };
function exportScore() {
  const a = ws.score.all;
  const now = { delivered: a.delivered, missedOpen: a.missedOpen5Min, missedQuick: a.missed - a.missedOpen5Min, late: a.late, duplicates: a.duplicates, unexpected: a.unexpected, backfill: a.backfill };
  const inc = (c: client.Counter<string>, label: Record<string, string>, d: number) => { if (d > 0) c.inc(label, d); };
  inc(settled, { outcome: 'delivered' }, now.delivered - last.delivered);
  inc(settled, { outcome: 'missed_open' }, now.missedOpen - last.missedOpen);
  inc(settled, { outcome: 'missed_quick' }, now.missedQuick - last.missedQuick);
  inc(other, { kind: 'late' }, now.late - last.late);
  inc(other, { kind: 'duplicate' }, now.duplicates - last.duplicates);
  inc(other, { kind: 'unexpected' }, now.unexpected - last.unexpected);
  inc(other, { kind: 'backfill' }, now.backfill - last.backfill);
  last = now;
}
const snapshot = () => ({ seed, now: clock.now(), speed: clock.speed, loadsPerDay: ws.loadsPerDay, users: users.length,
  searches: users.reduce((n, u) => n + u.searches.length, 0), world: ws.world, boards: ws.boards, engine: engine.counts(), score: ws.score });
setInterval(() => send('stats', snapshot()), 1_000);

// ---------- search parser (hybrid: rules + GLiNER2, every model call traced to Langfuse) ----------
const places = createPlaceIndex(join(here, '../sim/data'));
const gliner = createGlinerExtractor(a.gliner!, { tracer: tracing.tracer });
async function parse(text: string) {
  return span('parse.search', { 'search.text': text, 'parse.mode': 'hybrid' }, async (s) => {
    const calls: ModelCall[] = [];
    const go = (mode: 'hybrid' | 'rules') => parseSearch(text, { places, mode, extractor: mode === 'hybrid' ? gliner : undefined, onModelCall: (c) => calls.push(c), context: { sessionId: 'live-ui' } });
    let result, fallback = false;
    try { result = await go('hybrid'); } catch (e) { log('warn', 'parse.model_unavailable', { error: String(e) }); result = await go('rules'); fallback = true; }   // model down: rules still work
    const summary = describe(result);
    s?.setAttributes({ 'parse.summary': summary, 'parse.sources': JSON.stringify(result.sources), 'parse.questions': result.questions.join(' | '), 'parse.model_calls': calls.length, 'parse.fallback': fallback });
    log('info', 'search.parsed', { text, summary, model_calls: calls.length, questions: result.questions.join(' | ') || undefined, fallback });
    return { result, summary, calls: calls.map((c) => ({ model: c.model, latencyMs: Math.round(c.latencyMs), traceId: c.traceId })), fallback };
  });
}

// ---------- HTTP API + static UI ----------
const body = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; };
const json = (res: ServerResponse, status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const uiDir = join(here, '../ui/dist');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
let nextSearch = saved.reduce((n, s) => Math.max(n, Number(s.spec.searchId.slice(1))), 0);

// Saving or removing a search: rebuild the engine's index and polling plans, cancel orphaned alerts, rebuild the answer key.
const refresh = () => span('engine.refresh_searches', {}, (s) => {
  const cancelled = engine.refreshSearches();
  toWorld({ type: 'searches', userId: YOU, searches: you.searches, createdAt: [...createdAt] });   // the answer key follows
  s?.setAttributes({ 'searches.total': users.reduce((n, u) => n + u.searches.length, 0), 'alerts.cancelled': cancelled });
  return cancelled;
});

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://live');
  const traced = url.pathname.startsWith('/api/') && url.pathname !== '/api/events' && url.pathname !== '/api/state';
  if (!traced || !tracing.tracer) return void handle(req, res, url, null);
  tracing.tracer.startActiveSpan(`${req.method} ${url.pathname.replace(/\/Y\d+$/, '/:id')}`, { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method ?? '', 'url.path': url.pathname } },
    async (s) => { await handle(req, res, url, s); s.setAttribute('http.response.status_code', res.statusCode); if (res.statusCode >= 500) s.setStatus({ code: SpanStatusCode.ERROR }); s.end(); });
}).listen(Number(a.port), '0.0.0.0', () => log('info', 'live.started', { port: Number(a.port), seed, users: users.length, speed: clock.speed }));

// Load the agent's model and its instructions now (agent.ts warmAgent), so the first "Should I take it?" takes
// ~5 s instead of ~25 s.
warmAgent(a.ollama!, a['agent-model']!)
  .then((status) => log('info', 'agent.warmed', { model: a['agent-model'], status }))
  .catch((e) => log('warn', 'agent.warm_failed', { model: a['agent-model'], error: String(e) }));

async function handle(req: IncomingMessage, res: ServerResponse, url: URL, reqSpan: Span | null) {
  try {
    if (url.pathname === '/metrics') { res.writeHead(200, { 'content-type': reg.contentType }); res.end(await reg.metrics()); return; }
    if (url.pathname === '/api/state') return json(res, 200, { ...snapshot(), you: saved, postings: recentPostings, alerts: recentAlerts });
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: stats\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/parse' && req.method === 'POST') return json(res, 200, { ...(await parse(String((await body(req)).text ?? ''))), requestTraceId: reqSpan?.spanContext().traceId ?? null });
    if (url.pathname === '/api/searches' && req.method === 'POST') {
      const b = await body(req);
      const p = await parse(String(b.text ?? ''));
      const r = p.result;
      const equipment = (b.equipment ?? r.equipment) as Equip | null;
      if (!r.origin || !equipment) return json(res, 400, { error: 'Need at least where the truck is and the equipment type.', ...p });
      const spec: SearchSpec = { searchId: `Y${++nextSearch}`, userId: YOU, lat: r.origin.lat, lon: r.origin.lon, deadheadMi: Number(b.deadheadMi ?? r.deadheadMi),
        dest: r.dest ?? { kind: 'anywhere' }, equipment, minRpm: b.minRpm === undefined ? r.minRpm : b.minRpm, includeNoRate: true, pickupWithinDays: 3 };
      const s: SavedSearch = { spec, text: String(b.text), summary: describe({ ...r, equipment, minRpm: spec.minRpm, deadheadMi: spec.deadheadMi, dest: r.dest ?? { kind: 'anywhere' } }), createdAt: clock.now() };
      saved.push(s); you.searches.push(spec); createdAt.set(spec.searchId, s.createdAt);
      persist();
      await refresh();
      log('info', 'search.saved', { search_id: spec.searchId, summary: s.summary, text: s.text });
      return json(res, 200, { search: s, ...p, requestTraceId: reqSpan?.spanContext().traceId ?? null });
    }
    const del = /^\/api\/searches\/(\w+)$/.exec(url.pathname);
    if (del && req.method === 'DELETE') {
      const i = saved.findIndex((s) => s.spec.searchId === del[1]);
      if (i >= 0) {
        saved.splice(i, 1); you.searches.splice(you.searches.findIndex((s) => s.searchId === del[1]), 1); persist();
        const cancelled = await refresh();
        log('info', 'search.removed', { search_id: del[1], alerts_cancelled: cancelled });
      }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/speed' && req.method === 'POST') { clock.setSpeed(Math.min(120, Math.max(1, Number((await body(req)).speed) || 1))); toWorld({ type: 'clock', anchor: clock.anchor() }); log('info', 'control.speed', { speed: clock.speed }); return json(res, 200, { speed: clock.speed }); }
    if (url.pathname === '/api/rate' && req.method === 'POST') {
      const loadsPerDay = Math.min(500_000, Math.max(1_000, Number((await body(req)).loadsPerDay) || 20_000));
      toWorld({ type: 'rate', loadsPerDay }); ws.loadsPerDay = loadsPerDay;
      log('info', 'control.volume', { loads_per_day: loadsPerDay });
      return json(res, 200, { loadsPerDay });
    }
    if (url.pathname === '/api/burst' && req.method === 'POST') {
      const b = await body(req);
      const city = String(b.city ?? 'Chicago'), equipment = (b.equipment ?? 'van') as Equip, count = Math.min(5_000, Number(b.count) || 500);
      await span('world.burst', { city, equipment, count }, () => toWorld({ type: 'burst', city, equipment, count }));
      log('info', 'control.burst', { city, equipment, count });
      return json(res, 200, { ok: true });
    }
    // "Should I take it?": the load-decision agent on one alerted load, for your truck (ML.md, ml/agent).
    if (url.pathname === '/api/agent' && req.method === 'POST') {
      const loadId = String((await body(req)).loadId ?? '');
      const f = await loadFacts(loadId);
      if (!f.load || f.market === null) return json(res, 404, { error: 'That load is no longer on the boards.' });
      // Your truck: where your best-matching saved search says it is, its deadhead and minimum rate; no tarps,
      // not frozen-capable, 45,000 lbs max (a dry-van or flatbed default; editable later).
      const s = you.searches.filter((x) => x.equipment === f.load!.equipment)
        .sort((p1, p2) => milesBetween(p1.lat, p1.lon, f.load!.origin_lat, f.load!.origin_lon) - milesBetween(p2.lat, p2.lon, f.load!.origin_lat, f.load!.origin_lon))[0];
      if (!s) return json(res, 400, { error: `None of your searches is for ${f.load.equipment}.` });
      const sv = saved.find((x) => x.spec.searchId === s.searchId);
      const truck: Truck = { location: sv ? sv.summary.split('·')[1]?.trim().replace(/^within \d+ mi of /, '').split(' →')[0] ?? 'your truck' : 'your truck', lat: s.lat, lon: s.lon,
        equipment: s.equipment, has_tarps: false, frozen_capable: false, max_weight_lbs: 45_000, max_deadhead_mi: s.deadheadMi, min_rate_per_mile: s.minRpm };
      const { origin_lat, origin_lon, ...load } = f.load;
      const facts: Facts = { load, truck, market_rate_per_mile: f.market, deadhead_miles: Math.round(milesBetween(s.lat, s.lon, origin_lat, origin_lon) * 1.17) };
      const run = await runAgent({ url: a.ollama!, model: a['agent-model']!, mode: a['agent-mode'] as AgentMode, facts, tracer: tracing.tracer, sessionId: 'live-agent', metadata: { load_id: loadId } });
      const policy = decide(facts);
      log('info', 'agent.decided', { load_id: loadId, model: a['agent-model'], mode: a['agent-mode'], verdict: run.decision?.verdict, policy: policy.verdict,
        agrees: run.decision?.verdict === policy.verdict, latency_ms: Math.round(run.latencyMs), model_calls: run.modelCalls, error: run.error ?? undefined });
      return json(res, 200, { decision: run.decision, error: run.error, policy, facts, model: a['agent-model'], mode: a['agent-mode'],
        latencyMs: Math.round(run.latencyMs), modelCalls: run.modelCalls, tokens: { in: run.inputTokens, out: run.outputTokens }, requestTraceId: reqSpan?.spanContext().traceId ?? null });
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    // static UI (single page app)
    const file = normPath(join(uiDir, url.pathname === '/' ? 'index.html' : url.pathname));
    const target = file.startsWith(uiDir) && existsSync(file) && extname(file) ? file : join(uiDir, 'index.html');
    if (!existsSync(target)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('UI not built: cd ui && npm run build'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  } catch (e) { log('error', 'api.error', { path: url.pathname, error: String(e) }); json(res, 500, { error: String(e) }); }
}
