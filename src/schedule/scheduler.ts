import type { Clock } from '../shared/clock.ts';
import { createHeap } from '../shared/heap.ts';
import { createTokenBucket, type TokenBucket } from '../shared/bucket.ts';
import type { PlanEntry } from '../shared/types.ts';

export type SchedulerStats = { entries: number; credentials: number; paused: number; banned: number; pausedTotal: number; bannedTotal: number; stretch: number; dispatched: number; deferredByBudget: number };

type Cred = { bucket: TokenBucket; banned: boolean; pausedUntil: number; consecutive429: number; recent429: number[]; restoreAt: number; gen: number; entries: Map<string, PlanEntry> };
type Item = { at: number; entry: PlanEntry; gen: number };

const MIN = 60_000;

// LLD 6.3: one heap of (next run time, plan entry); every run spends a token from that login's budget.
export function createScheduler(opts: { clock: Clock; budgetPerMin: number; dispatch(e: PlanEntry): boolean; jitter?: () => number }) {
  const { clock, budgetPerMin } = opts;
  const jitter = opts.jitter ?? (() => 0.9 + 0.2 * Math.random());
  const heap = createHeap<Item>((a, b) => a.at < b.at);
  const creds = new Map<string, Cred>();
  const totals = { pausedTotal: 0, bannedTotal: 0, dispatched: 0, deferredByBudget: 0 };
  let stretch = 1;

  const cred = (id: string) => {
    let c = creds.get(id);
    if (!c) {
      c = { bucket: createTokenBucket(budgetPerMin, Math.max(1, budgetPerMin / 6), clock), banned: false, pausedUntil: 0, consecutive429: 0, recent429: [], restoreAt: 0, gen: 0, entries: new Map() };
      creds.set(id, c);
    }
    return c;
  };

  function tick(): number {
    const now = clock.now();
    let n = 0;
    while (heap.size() && heap.peek()!.at <= now && n < 2000) {
      const it = heap.pop()!;
      const c = creds.get(it.entry.credentialId)!;
      if (it.gen !== c.gen || c.banned) continue;
      if (c.restoreAt && now >= c.restoreAt) { c.bucket.setRatePerMin(budgetPerMin); c.restoreAt = 0; }
      if (c.pausedUntil > now) { heap.push({ ...it, at: c.pausedUntil }); continue; }
      if (!c.bucket.take()) { totals.deferredByBudget++; heap.push({ ...it, at: c.bucket.nextTokenAt() }); continue; }
      n++;
      if (opts.dispatch(it.entry)) { totals.dispatched++; stretch = Math.max(1, stretch * 0.995); }
      else stretch = Math.min(8, stretch * 1.2);                       // pollers behind: poll less often
      heap.push({ ...it, at: now + it.entry.intervalMs * stretch * jitter() });
    }
    return heap.size() ? Math.max(0, heap.peek()!.at - now) : 1_000;
  }

  return {
    setEntries(credentialId: string, entries: PlanEntry[]) {
      const c = cred(credentialId);
      c.gen++;
      const now = clock.now();
      const next = new Map<string, PlanEntry>();
      for (const e of entries) {
        const old = c.entries.get(e.entryId);
        if (old) e.cursor = old.cursor;
        next.set(e.entryId, e);
        heap.push({ at: now + Math.random() * Math.min(e.intervalMs, 10_000), entry: e, gen: c.gen });
      }
      c.entries = next;
    },
    report(credentialId: string, status: number, retryAfterSec?: number) {
      const c = cred(credentialId);
      const now = clock.now();
      if (status === 200) { c.consecutive429 = 0; return; }
      if (status === 403) { if (!c.banned) { c.banned = true; totals.bannedTotal++; } return; }
      if (status !== 429) return;
      c.consecutive429++;
      c.recent429 = c.recent429.filter((t) => now - t < 10 * MIN);
      c.recent429.push(now);
      if (c.recent429.length >= 3) {                                    // circuit breaker
        c.pausedUntil = now + 15 * MIN;
        c.bucket.setRatePerMin(budgetPerMin / 2);
        c.restoreAt = now + 60 * MIN;
        c.recent429 = [];
        totals.pausedTotal++;
        return;
      }
      const backoff = 2 ** c.consecutive429 * 5_000;
      c.pausedUntil = now + Math.min(15 * MIN, Math.max((retryAfterSec ?? 0) * 1000, backoff) * jitter());
    },
    tick,
    async run(): Promise<never> {
      for (;;) { const wait = tick(); await clock.sleep(Math.max(Math.min(wait, 1_000), 5 * clock.speed)); }
    },
    stats(): SchedulerStats {
      const now = clock.now();
      let paused = 0, banned = 0, entries = 0;
      for (const c of creds.values()) { if (c.banned) banned++; else if (c.pausedUntil > now) paused++; entries += c.entries.size; }
      return { entries, credentials: creds.size, paused, banned, ...totals, stretch };
    },
  };
}
