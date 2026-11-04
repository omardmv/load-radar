// "The outside world" on its own thread (own event loop, own core): the load stream, the simulated boards and
// Telegram (HTTP on 127.0.0.1:7001/7002, so the engine talks to them exactly as it would to real ones), and the live
// answer key, which has to see both sides: loads as they are born and alerts as they are delivered.
// The main thread (live/server.ts) runs the engine and the API; the two only exchange messages.
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { createAdjustableClock, type ClockAnchor } from '../src/shared/clock.ts';
import type { Equip, SearchSpec, User } from '../src/shared/types.ts';
import { createBoardsHandler } from '../sims/boards-sim.ts';
import { createTelegramHandler, type Delivery } from '../sims/telegram-sim.ts';
import { createWorld, type Truth } from '../sim/world.ts';
import { createStream } from './stream.ts';
import { createLiveScore } from './score.ts';

export type WorldInit = { seed: number; anchor: ClockAnchor; loadsPerDay: number; budget: number; users: User[]; createdAt: [string, number][]; watch: string };
export type ToWorld =
  | { type: 'clock'; anchor: ClockAnchor }
  | { type: 'rate'; loadsPerDay: number }
  | { type: 'burst'; city: string; equipment: Equip; count: number }
  | { type: 'searches'; userId: string; searches: SearchSpec[]; createdAt: [string, number][] };

const init = workerData as WorldInit;
const port = parentPort!;
const clock = createAdjustableClock({ simStart: init.anchor.simAnchor, speed: init.anchor.speed });
clock.setAnchor(init.anchor);
const world = createWorld((init.seed ^ 0x5bd1e995) >>> 0);          // its own random stream (users come from the main thread)
const users = init.users;
const createdAt = new Map(init.createdAt);
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();

const lane = (t: Truth) => ({ from: `${t.origin.city}, ${t.origin.state}`, to: `${t.dest.city}, ${t.dest.state}`, equipment: t.equipment, rate: t.rate, miles: t.miles, pickup: t.pickup_date });
let postingBatch: unknown[] = [];
const score = createLiveScore({ users, watch: init.watch, createdAt });
const stream = createStream({ world, clock, loadsPerDay: init.loadsPerDay, onLoad: score.onLoad,
  onPosting: (p) => { postingBatch.push({ at: p.at, board: p.board, kind: p.kind, loadId: p.loadId, ...lane(p.truth) }); if (postingBatch.length > 200) postingBatch = postingBatch.slice(-50); } });
const boards = createBoardsHandler(stream.data, { clock, budgetPerMin: init.budget, banAfterRejects: 20, banWindowMs: 10 * 60_000 });
const telegram = createTelegramHandler({ clock, perBotPerSec: 30, perChatPerSec: 1, onDelivered: (d: Delivery) => {
  const checked = score.onDelivery(d, stream.loadOf);
  if (d.chatId === init.watch) port.postMessage({ type: 'alert', alert: { at: d.at, lines: (d.text ?? '').split('\n'), loads: checked } });
} });

port.on('message', (m: ToWorld) => {
  if (m.type === 'clock') clock.setAnchor(m.anchor);
  else if (m.type === 'rate') stream.setLoadsPerDay(m.loadsPerDay);
  else if (m.type === 'burst') stream.burst(m.city, m.equipment, m.count);
  else if (m.type === 'searches') {
    const u = users.find((x) => x.userId === m.userId);
    if (u) u.searches = m.searches;
    for (const [id, t] of m.createdAt) createdAt.set(id, t);
    score.rebuild();
  }
});

await new Promise<void>((r) => createServer(boards).listen(7001, '127.0.0.1', r));
await new Promise<void>((r) => createServer(telegram).listen(7002, '127.0.0.1', r));
setInterval(() => { stream.tick(); if (postingBatch.length) { port.postMessage({ type: 'postings', postings: postingBatch.slice(-12) }); postingBatch = []; } }, 250);
setInterval(() => { score.sweep(clock.now()); stream.prune(); }, 5_000);
setInterval(() => {
  port.postMessage({ type: 'stats', world: { ...stream.stats, scheduled: stream.pending() }, boards: { ...boards.stats }, score: score.summary(),
    loadsPerDay: stream.loadsPerDay, loopP99Ms: loop.percentile(99) / 1e6 });
  loop.reset();
}, 1_000);
port.postMessage({ type: 'ready' });
