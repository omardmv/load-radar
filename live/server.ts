// Live mode: one always-on process with the whole loop, fresh data every start.
//   world stream (new loads forever) -> simulated boards -> engine (poll, dedup, match, alert) -> simulated Telegram
//   -> live scorer (answer key built as loads are born). The UI (ui/, shadcn) talks to the API below.
//
//   node live/server.ts --port 8080 --gliner http://gliner2:7100 --otlp http://otel-collector:4318/v1/traces
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import { createAdjustableClock } from '../src/shared/clock.ts';
import { BOARDS, type SearchSpec, type User, type Equip } from '../src/shared/types.ts';
import { toUser } from '../src/data/users.ts';
import { startEngine } from '../src/engine.ts';
import { createBoardsHandler } from '../sims/boards-sim.ts';
import { createTelegramHandler, type Delivery } from '../sims/telegram-sim.ts';
import { createWorld, type Truth } from '../sim/world.ts';
import { createPlaceIndex } from '../src/parse/places.ts';
import { parseSearch } from '../src/parse/parse.ts';
import { createGlinerExtractor } from '../src/parse/gliner.ts';
import { describe } from '../src/parse/normalize.ts';
import type { ModelCall } from '../src/parse/types.ts';
import { setupLlmTracing } from '../src/obs/llm.ts';
import { setupLogs } from '../src/obs/log.ts';
import { createStream } from './stream.ts';
import { createLiveScore } from './score.ts';

const { values: a } = parseArgs({ options: {
  port: { type: 'string', default: '8080' }, speed: { type: 'string', default: '1' }, 'loads-per-day': { type: 'string', default: '20000' },
  users: { type: 'string', default: '300' }, seed: { type: 'string', default: '' }, budget: { type: 'string', default: '60' },
  gliner: { type: 'string', default: 'http://127.0.0.1:7100' }, otlp: { type: 'string', default: 'off' }, 'metrics-port': { type: 'string', default: '9464' },
  state: { type: 'string', default: 'data/live' } } });

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
const lane = (t: Truth) => ({ from: `${t.origin.city}, ${t.origin.state}`, to: `${t.dest.city}, ${t.dest.state}`, equipment: t.equipment, rate: t.rate, miles: t.miles, pickup: t.pickup_date });
let postingBatch: unknown[] = [];

// ---------- the loop ----------
const score = createLiveScore({ users, watch: YOU, createdAt });
const stream = createStream({ world, clock, loadsPerDay: Number(a['loads-per-day']), onLoad: score.onLoad,
  onPosting: (p) => { const x = { at: p.at, board: p.board, kind: p.kind, loadId: p.loadId, ...lane(p.truth) }; ring(recentPostings, x, 60); postingBatch.push(x); } });
const boards = createBoardsHandler(stream.data, { clock, budgetPerMin: Number(a.budget), banAfterRejects: 20, banWindowMs: 10 * 60_000 });
const telegram = createTelegramHandler({ clock, perBotPerSec: 30, perChatPerSec: 1, onDelivered: (d: Delivery) => {
  const checked = score.onDelivery(d, stream.loadOf);
  if (d.chatId !== YOU) return;
  const alert = { at: d.at, lines: (d.text ?? '').split('\n'), loads: checked };
  ring(recentAlerts, alert, 100);
  send('alert', alert);
  for (const x of checked) log('info', 'alert.sent', { user: d.chatId, load_id: x.loadId, latency_sec: x.latencySec ?? undefined, expected: x.expected, late: x.late, backfill: x.backfill, text: alert.lines.join(' | ') });
} });
await new Promise<void>((r) => createServer(boards).listen(7001, '127.0.0.1', r));
await new Promise<void>((r) => createServer(telegram).listen(7002, '127.0.0.1', r));
const engine = await startEngine({ users, boardsUrl: 'http://127.0.0.1:7001', telegramUrl: 'http://127.0.0.1:7002', clock, budgetPerMin: Number(a.budget),
  connectionsPerBoard: 64, metricsPort: Number(a['metrics-port']) || null, otlpEndpoint: a.otlp === 'off' ? null : a.otlp!, sampleRate: 0.01, maxUsers: 0, bots: 4 });

setInterval(() => { stream.tick(); if (postingBatch.length) { send('postings', postingBatch.slice(-12)); postingBatch = []; } }, 250);
setInterval(() => { score.sweep(clock.now()); stream.prune(); }, 5_000);
const snapshot = () => ({ seed, now: clock.now(), speed: clock.speed, loadsPerDay: stream.loadsPerDay, users: users.length,
  searches: users.reduce((n, u) => n + u.searches.length, 0), world: { ...stream.stats, scheduled: stream.pending() }, boards: boards.stats,
  engine: engine.counts(), score: score.summary() });
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
  score.rebuild();
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

async function handle(req: IncomingMessage, res: ServerResponse, url: URL, reqSpan: Span | null) {
  try {
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
    if (url.pathname === '/api/speed' && req.method === 'POST') { clock.setSpeed(Math.min(120, Math.max(1, Number((await body(req)).speed) || 1))); log('info', 'control.speed', { speed: clock.speed }); return json(res, 200, { speed: clock.speed }); }
    if (url.pathname === '/api/rate' && req.method === 'POST') { stream.setLoadsPerDay(Math.min(500_000, Math.max(1_000, Number((await body(req)).loadsPerDay) || 20_000))); log('info', 'control.volume', { loads_per_day: stream.loadsPerDay }); return json(res, 200, { loadsPerDay: stream.loadsPerDay }); }
    if (url.pathname === '/api/burst' && req.method === 'POST') {
      const b = await body(req);
      const city = String(b.city ?? 'Chicago'), equipment = (b.equipment ?? 'van') as Equip, count = Math.min(5_000, Number(b.count) || 500);
      await span('world.burst', { city, equipment, count }, () => stream.burst(city, equipment, count));
      log('info', 'control.burst', { city, equipment, count });
      return json(res, 200, { ok: true });
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
