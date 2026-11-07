// One shard of the simulated boards, on its own thread and port. Every shard holds every posting (the world's main
// thread sends each new one to all shards), but each engine sends a given login's requests to one shard only
// (hash of the login id), so that login's rate limit and ban state live in exactly one place.
import { createServer } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
import { createSimClock } from '../src/shared/clock.ts';
import { createBoardsHandler, type BoardData, type SimItem } from '../sims/boards-sim.ts';

export type ShardInit = { port: number; budget: number };
export type ToShard = { type: 'items'; items: { board: string; cell: string; item: SimItem }[] };

const init = workerData as ShardInit;
const clock = createSimClock({ simStart: Date.now(), speed: 1 });              // wall time, like the engines
const data: BoardData = new Map();
const boards = createBoardsHandler(data, { clock, budgetPerMin: init.budget, banAfterRejects: 20, banWindowMs: 10 * 60_000 });

parentPort!.on('message', (m: ToShard) => {
  for (const { board, cell, item } of m.items) {
    let byCell = data.get(board);
    if (!byCell) { byCell = new Map(); data.set(board, byCell); }
    const list = byCell.get(cell);
    if (list) list.push(item); else byCell.set(cell, [item]);                   // items arrive in postedAt order
  }
});
// Drop postings older than 6 h, like the stream does.
setInterval(() => {
  const cutoff = clock.now() - 6 * 3_600_000;
  for (const byCell of data.values()) for (const [cell, list] of byCell) {
    let i = 0; while (i < list.length && list[i].postedAt < cutoff) i++;
    if (i === list.length) byCell.delete(cell); else if (i) list.splice(0, i);
  }
}, 5_000);
setInterval(() => parentPort!.postMessage({ type: 'stats', stats: boards.stats }), 1_000);

const server = createServer(boards);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(init.port, '0.0.0.0');
