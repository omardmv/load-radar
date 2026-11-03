import { Agent, fetch } from 'undici';
import type { Clock } from '../shared/clock.ts';
import { centralDate } from '../shared/geo.ts';
import { createSemaphore, type Semaphore } from '../shared/semaphore.ts';
import type { PlanEntry } from '../shared/types.ts';

export type PollResult = { status: number; retryAfterSec?: number; items: unknown[]; requestMs: number; poolWaitMs: number };

// LLD 6.4 and section 9: one keep-alive pool per board, sized by Little's law (rate x latency). Our own semaphore
// with the same size makes the wait for a socket visible (it would otherwise queue silently inside the client).
export function createPoller(opts: { baseUrl: string; connectionsPerBoard: number; clock: Clock; timeoutMs: number; onResponse(e: PlanEntry, r: PollResult): void }) {
  const pools = new Map<string, { agent: Agent; sem: Semaphore }>();
  let inFlight = 0;
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
      const now = opts.clock.now();
      const q = new URLSearchParams({ lat: String(e.query.lat), lon: String(e.query.lon), radius: String(e.query.radiusMi), equipment: e.query.equipment.join(','),
        pickup_from: centralDate(now), pickup_to: centralDate(now + 7 * 86_400_000), since: String(e.cursor) });
      const t1 = performance.now();
      let r: PollResult;
      try {
        const res = await fetch(`${opts.baseUrl}/${e.board}/loads?${q}`, { headers: { 'x-credential': e.credentialId }, dispatcher: agent, signal: AbortSignal.timeout(opts.timeoutMs) });
        if (res.status === 200) {
          const body = (await res.json()) as { now: number; items: unknown[] };
          e.cursor = body.now;
          r = { status: 200, items: body.items, requestMs: performance.now() - t1, poolWaitMs };
        } else {
          const ra = res.headers.get('retry-after');
          await res.arrayBuffer();
          r = { status: res.status, retryAfterSec: ra ? Number(ra) : undefined, items: [], requestMs: performance.now() - t1, poolWaitMs };
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
