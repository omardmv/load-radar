// One engine shard on its own thread (and so its own core). Live mode with --engine-workers N starts N of these;
// each owns a share of the dispatchers (and so their board logins, alerts and Telegram chats), so the shards share
// nothing: a login is polled by exactly one shard, and "one alert per (user, load)" stays a local check.
// The main thread keeps the API and UI; the world thread keeps the boards. Shards talk to both over HTTP or messages.
import { parentPort, workerData } from 'node:worker_threads';
import { createAdjustableClock, type ClockAnchor } from '../src/shared/clock.ts';
import type { SearchSpec, User } from '../src/shared/types.ts';
import { startEngine } from '../src/engine.ts';

export type EngineShardInit = { shard: number; anchor: ClockAnchor; users: User[]; budget: number; metricsPort: number; otlp: string | null;
  dedupModel: string | null; bots: number; botOffset: number };
export type ToShard =
  | { type: 'clock'; anchor: ClockAnchor }
  | { type: 'searches'; reqId: number; userId: string; searches: SearchSpec[] };

const init = workerData as EngineShardInit;
const port = parentPort!;
const clock = createAdjustableClock({ simStart: init.anchor.simAnchor, speed: init.anchor.speed });
clock.setAnchor(init.anchor);
const users = init.users;
const engine = await startEngine({ users, boardsUrl: 'http://127.0.0.1:7001', telegramUrl: 'http://127.0.0.1:7002', clock, budgetPerMin: init.budget,
  connectionsPerBoard: 64, metricsPort: init.metricsPort, otlpEndpoint: init.otlp, sampleRate: 0.01, maxUsers: 0, bots: init.bots, botOffset: init.botOffset,
  dedupModel: init.dedupModel });

port.on('message', (m: ToShard) => {
  if (m.type === 'clock') clock.setAnchor(m.anchor);
  else if (m.type === 'searches') {
    const u = users.find((x) => x.userId === m.userId);
    if (u) u.searches = m.searches;
    port.postMessage({ type: 'refreshed', reqId: m.reqId, cancelled: engine.refreshSearches() });
  }
});
setInterval(() => port.postMessage({ type: 'counts', shard: init.shard, counts: engine.counts() }), 1_000);
port.postMessage({ type: 'ready', shard: init.shard });
