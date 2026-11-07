import { Agent } from 'undici';
import type { Clock } from '../shared/clock.ts';
import { centralDate } from '../shared/geo.ts';
import { createSemaphore, type Semaphore } from '../shared/semaphore.ts';
import type { PlanEntry } from '../shared/types.ts';

export type PollResult = { status: number; retryAfterSec?: number; items: unknown[]; requestMs: number; poolWaitMs: number };

// LLD 6.4 and section 9: one keep-alive pool per board, sized by Little's law (rate x latency). Our own semaphore
// with the same size makes the wait for a socket visible (it would otherwise queue silently inside the client).
// Requests use undici's low-level request(), not fetch(): fetch builds Request/Response/Headers objects and web
// streams and needs a timer per request for its timeout; request() takes the timeouts as options. Same HTTP, less CPU.
export function createPoller(opts: { baseUrl: string; connectionsPerBoard: number; clock: Clock; timeoutMs: number; onResponse(e: PlanEntry, r: PollResult): void }) {
  const pools = new Map<string, { agent: Agent; sem: Semaphore }>();
  const base = new URL(opts.baseUrl);
  const origin = base.origin, prefix = base.pathname.replace(/\/$/, '');
  let inFlight = 0;
  // The pickup window changes once a day: format it once a minute, not on every request.
  let windowAt = -Infinity, window = '';
  const pickupWindow = (now: number) => {
    if (now - windowAt > 60_000) { windowAt = now; window = `&pickup_from=${centralDate(now)}&pickup_to=${centralDate(now + 7 * 86_400_000)}`; }
    return window;
  };
  const pool = (board: string) => {
    let p = pools.get(board);
    if (!p) { p = { agent: new Agent({ connections: opts.connectionsPerBoard, keepAliveTimeout: 30_000 }), sem: createSemaphore(opts.connectionsPerBoard) }; pools.set(board, p); }
    return p;
  };
  return {
    inFlight: () => inFlight,
    async poll(e: PlanEntry): Promise<void> {
      const { agent, sem } = pool(e.board);
      const t0 = performance.now();
      await sem.acquire();
      const poolWaitMs = performance.now() - t0;
      inFlight++;
      const path = `${prefix}/${e.board}/loads?lat=${e.query.lat}&lon=${e.query.lon}&radius=${e.query.radiusMi}&equipment=${e.query.equipment.join(',')}` +
        `${pickupWindow(opts.clock.now())}&since=${e.cursor}`;
      const t1 = performance.now();
      let r: PollResult;
      try {
        const res = await agent.request({ origin, path, method: 'GET', headers: { 'x-credential': e.credentialId }, headersTimeout: opts.timeoutMs, bodyTimeout: opts.timeoutMs });
        if (res.statusCode === 200) {
          const body = (await res.body.json()) as { now: number; items: unknown[] };
          e.cursor = body.now;
          r = { status: 200, items: body.items, requestMs: performance.now() - t1, poolWaitMs };
        } else {
          const ra = res.headers['retry-after'];
          await res.body.dump();
          r = { status: res.statusCode, retryAfterSec: ra ? Number(ra) : undefined, items: [], requestMs: performance.now() - t1, poolWaitMs };
        }
      } catch {
        r = { status: 0, items: [], requestMs: performance.now() - t1, poolWaitMs };
      } finally {
        inFlight--;
        sem.release();
      }
      opts.onResponse(e, r);
    },
    async close() { await Promise.all([...pools.values()].map((p) => p.agent.close())); },
  };
}
