// The outside world for the engine cluster, as its own container: the endless load stream, the simulated boards
// (:7001), the web alert channel (:7002) and the live answer key. Engines reach it over the network exactly as they
// would reach real boards. Dispatchers are registered here too (:7003), so the answer key knows what each should get.
//   node cluster/world.ts --loads-per-day 100000
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import client from 'prom-client';
import { createAdjustableClock } from '../src/shared/clock.ts';
import type { User } from '../src/shared/types.ts';
import { createBoardsHandler } from '../sims/boards-sim.ts';
import { createTelegramHandler } from '../sims/telegram-sim.ts';
import { createWorld } from '../sim/world.ts';
import { createStream } from '../live/stream.ts';
import { createLiveScore } from '../live/score.ts';

const { values: a } = parseArgs({ options: { 'loads-per-day': { type: 'string', default: '100000' }, budget: { type: 'string', default: '60' },
  seed: { type: 'string', default: '1' }, 'metrics-port': { type: 'string', default: '9464' } } });
const clock = createAdjustableClock({ simStart: Date.now(), speed: 1 });       // real time: engines use the wall clock too
const users: User[] = [];
const createdAt = new Map<string, number>();
const score = createLiveScore({ users, watch: '', createdAt });
const stream = createStream({ world: createWorld(Number(a.seed)), clock, loadsPerDay: Number(a['loads-per-day']), onLoad: score.onLoad, onPosting: () => {} });
const boards = createBoardsHandler(stream.data, { clock, budgetPerMin: Number(a.budget), banAfterRejects: 20, banWindowMs: 10 * 60_000 });
const alerts = createTelegramHandler({ clock, perBotPerSec: 30, perChatPerSec: 1, onDelivered: (d) => score.onDelivery(d, stream.loadOf) });
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();

// Register dispatchers for the answer key (the dispatcher generator does this; engines learn about them through
// their own API). A search only expects loads posted after it was saved.
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; score.rebuild(); } }, 1_000);
createServer((req, res) => {
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
new client.Gauge({ name: 'boards_banned_logins', registers: [reg], help: 'logins the boards have banned', collect() { this.set(boards.stats.bannedLogins); } });
new client.Gauge({ name: 'boards_rejected_total', registers: [reg], help: 'board requests answered 429', collect() { this.set(boards.stats.rejected); } });
new client.Gauge({ name: 'boards_ok_total', registers: [reg], help: 'board requests answered 200', collect() { this.set(boards.stats.ok); } });
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
keepAlive(createServer(boards)).listen(7001, '0.0.0.0');
keepAlive(createServer(alerts)).listen(7002, '0.0.0.0');
setInterval(() => stream.tick(), 250);
setInterval(() => { score.sweep(clock.now()); stream.prune(); }, 5_000);
console.log(`world: boards :7001, alert channel :7002, registration :7003, metrics :${a['metrics-port']}`);
