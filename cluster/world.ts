// The outside world for the engine cluster, as its own container: the endless load stream, the simulated boards
// (N board threads on :7101, :7102, ..., cluster/boards-thread.ts), the web alert channel (:7002) and the live answer
// key. Engines reach it over the network exactly as they would reach real boards; GET :7003/boards lists the board
// threads. Dispatchers are registered here too (POST :7003/dispatchers), so the answer key knows what each should get.
//   node cluster/world.ts --loads-per-day 100000 --board-threads 4
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import client from 'prom-client';
import { createAdjustableClock } from '../src/shared/clock.ts';
import type { User } from '../src/shared/types.ts';
import type { ShardInit, ToShard } from './boards-thread.ts';
import { createTelegramHandler } from '../sims/telegram-sim.ts';
import { createWorld } from '../sim/world.ts';
import { createStream } from '../live/stream.ts';
import { createLiveScore } from '../live/score.ts';

const { values: a } = parseArgs({ options: { 'loads-per-day': { type: 'string', default: '100000' }, budget: { type: 'string', default: '60' },
  seed: { type: 'string', default: '1' }, 'board-threads': { type: 'string', default: '4' }, 'metrics-port': { type: 'string', default: '9464' } } });
const clock = createAdjustableClock({ simStart: Date.now(), speed: 1 });       // real time: engines use the wall clock too
const users: User[] = [];
const createdAt = new Map<string, number>();
const score = createLiveScore({ users, watch: '', createdAt });
// Board threads: each serves the same postings; an engine sends a given login to one thread (hash of the login id).
const shards = Array.from({ length: Number(a['board-threads']) }, (_, i) => {
  const w = new Worker(new URL('./boards-thread.ts', import.meta.url), { workerData: { port: 7101 + i, budget: Number(a.budget) } satisfies ShardInit });
  const st = { ok: 0, rejected: 0, bannedRequests: 0, bannedLogins: 0 };
  w.on('message', (m) => { if (m.type === 'stats') Object.assign(st, m.stats); });
  w.on('error', (e) => { console.error('board thread crashed', e); process.exit(1); });
  return { w, st, port: 7101 + i };
});
const boardStat = (k: 'ok' | 'rejected' | 'bannedLogins') => shards.reduce((n, s) => n + s.st[k], 0);
let outbox: ToShard['items'] = [];
const stream = createStream({ world: createWorld(Number(a.seed)), clock, loadsPerDay: Number(a['loads-per-day']), onLoad: score.onLoad,
  onPosting: (p) => { outbox.push({ board: p.board, cell: p.cell, item: p.item }); } });
const alerts = createTelegramHandler({ clock, perBotPerSec: 30, perChatPerSec: 1, onDelivered: (d) => score.onDelivery(d, stream.loadOf) });
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();

// Register dispatchers for the answer key (the dispatcher generator does this; engines learn about them through
// their own API). A search only expects loads posted after it was saved.
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; score.rebuild(); } }, 1_000);
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/boards') {
    const host = (req.headers.host ?? 'localhost').split(':')[0];
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(shards.map((s) => `http://${host}:${s.port}`))); return;
  }
  if (req.method !== 'POST' || req.url !== '/dispatchers') { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const now = clock.now();
    for (const u of JSON.parse(Buffer.concat(chunks).toString()) as User[]) {
      const i = users.findIndex((x) => x.userId === u.userId);
      if (i >= 0) users[i] = u; else users.push(u);
      for (const s of u.searches) if (!createdAt.has(s.searchId)) createdAt.set(s.searchId, now);
    }
    dirty = true;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ dispatchers: users.length }));
  });
}).listen(7003, '0.0.0.0');

// Answer-key counters for the SLOs (same names as live mode), plus the boards' view of bans and rejections.
const reg = new client.Registry();
client.collectDefaultMetrics({ register: reg });
const settled = new client.Counter({ name: 'answer_key_settled_total', registers: [reg], labelNames: ['outcome'], help: 'expected alerts that settled: delivered, missed_open, missed_quick' });
const other = new client.Counter({ name: 'answer_key_other_total', registers: [reg], labelNames: ['kind'], help: 'deliveries outside the answer key: late, duplicate, unexpected, backfill' });
new client.Gauge({ name: 'world_eventloop_lag_p99_seconds', registers: [reg], help: 'event-loop delay p99 of the world', collect() { this.set(loop.percentile(99) / 1e9); loop.reset(); } });
new client.Gauge({ name: 'world_dispatchers', registers: [reg], help: 'dispatchers registered for the answer key', collect() { this.set(users.length); } });
new client.Gauge({ name: 'boards_banned_logins', registers: [reg], help: 'logins the boards have banned', collect() { this.set(boardStat('bannedLogins')); } });
new client.Gauge({ name: 'boards_rejected_total', registers: [reg], help: 'board requests answered 429', collect() { this.set(boardStat('rejected')); } });
new client.Gauge({ name: 'boards_ok_total', registers: [reg], help: 'board requests answered 200', collect() { this.set(boardStat('ok')); } });
let last = { delivered: 0, missedOpen: 0, missedQuick: 0, late: 0, duplicates: 0, unexpected: 0, backfill: 0 };
setInterval(() => {
  const s = score.summary().all;
  const now = { delivered: s.delivered, missedOpen: s.missedOpen5Min, missedQuick: s.missed - s.missedOpen5Min, late: s.late, duplicates: s.duplicates, unexpected: s.unexpected, backfill: s.backfill };
  const inc = (c: client.Counter<string>, l: Record<string, string>, d: number) => { if (d > 0) c.inc(l, d); };
  inc(settled, { outcome: 'delivered' }, now.delivered - last.delivered);
  inc(settled, { outcome: 'missed_open' }, now.missedOpen - last.missedOpen);
  inc(settled, { outcome: 'missed_quick' }, now.missedQuick - last.missedQuick);
  inc(other, { kind: 'late' }, now.late - last.late);
  inc(other, { kind: 'duplicate' }, now.duplicates - last.duplicates);
  inc(other, { kind: 'unexpected' }, now.unexpected - last.unexpected);
  inc(other, { kind: 'backfill' }, now.backfill - last.backfill);
  last = now;
}, 5_000);
createServer(async (_req, res) => { res.writeHead(200, { 'content-type': reg.contentType }); res.end(await reg.metrics()); }).listen(Number(a['metrics-port']), '0.0.0.0');

const keepAlive = (s: ReturnType<typeof createServer>) => { s.keepAliveTimeout = 65_000; s.headersTimeout = 66_000; return s; };
keepAlive(createServer(alerts)).listen(7002, '0.0.0.0');
setInterval(() => {
  stream.tick();
  if (outbox.length) { const m: ToShard = { type: 'items', items: outbox }; for (const s of shards) s.w.postMessage(m); outbox = []; }
}, 250);
setInterval(() => { score.sweep(clock.now()); stream.prune(); }, 5_000);
console.log(`world: ${shards.length} board threads :7101-${7100 + shards.length}, alert channel :7002, registration :7003, metrics :${a['metrics-port']}`);
