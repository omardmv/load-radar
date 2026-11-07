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
  // Several board servers (comma-separated): a login always goes to the same one (hash of its id), so its rate limit
  // lives in one place. One pool per (server, board).
  const servers = opts.baseUrl.split(',').map((u) => { const b = new URL(u.trim()); return { origin: b.origin, prefix: b.pathname.replace(/\/$/, '') }; });
  const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const pools = new Map<string, { agent: Agent; sem: Semaphore }>();
  let inFlight = 0;
  // The pickup window changes once a day: format it once a minute, not on every request.
  let windowAt = -Infinity, window = '';
  const pickupWindow = (now: number) => {
    if (now - windowAt > 60_000) { windowAt = now; window = `&pickup_from=${centralDate(now)}&pickup_to=${centralDate(now + 7 * 86_400_000)}`; }
    return window;
  };
  const perPool = Math.max(8, Math.ceil(opts.connectionsPerBoard / servers.length));
  const pool = (server: number, board: string) => {
    const k = `${server}|${board}`;
    let p = pools.get(k);
    if (!p) { p = { agent: new Agent({ connections: perPool, keepAliveTimeout: 30_000 }), sem: createSemaphore(perPool) }; pools.set(k, p); }
    return p;
  };
  return {
    inFlight: () => inFlight,
    async poll(e: PlanEntry): Promise<void> {
      const si = servers.length > 1 ? fnv(e.credentialId) % servers.length : 0;
      const { origin, prefix } = servers[si];
      const { agent, sem } = pool(si, e.board);
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
