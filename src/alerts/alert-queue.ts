import type { Clock } from '../shared/clock.ts';
import { createExpiringSet } from '../shared/expiring.ts';
import type { Alert } from '../shared/types.ts';

export interface AlertQueue {
  offer(a: Alert): boolean;
  take(max: number): { alerts: Alert[]; mode: 'oldest' | 'freshest' };
  size(): number;
  dropped(): number;
  oldestWaitMs(): number;
  removeWhere(drop: (a: Alert) => boolean): number;
}

export function createAlertQueue(opts: { clock: Clock; freshAfterMs: number; deadlineMs: number; ttlMs: number }): AlertQueue {
  const alerted = createExpiringSet(opts.ttlMs, 3_600_000, opts.clock);
  const items: Alert[] = [];            // sorted by postedAt, oldest first
  let dropped = 0;
  const insert = (a: Alert) => {
    let lo = 0, hi = items.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (items[m].postedAt <= a.postedAt) lo = m + 1; else hi = m; }
    items.splice(lo, 0, a);
  };
  const oldestWaitMs = () => {
    if (!items.length) return 0;
    let min = Infinity;
    for (const a of items) if (a.enqueuedAt < min) min = a.enqueuedAt;
    return opts.clock.now() - min;
  };
  return {
    offer(a) {
      const k = `${a.userId}:${a.canonicalId}`;
      if (alerted.has(k)) return false;
      alerted.add(k);
      insert(a);
      return true;
    },
    take(max) {
      const now = opts.clock.now();
      while (items.length && now - items[0].postedAt > opts.deadlineMs) { items.shift(); dropped++; }
      const mode = oldestWaitMs() >= opts.freshAfterMs ? 'freshest' : 'oldest';
      const n = Math.min(max, items.length);
      const alerts = mode === 'oldest' ? items.splice(0, n) : items.splice(items.length - n, n).reverse();
      return { alerts, mode };
    },
    size: () => items.length,
    dropped: () => dropped,
    oldestWaitMs,
    // A search was deleted: its waiting alerts must not go out.
    removeWhere(drop) { let n = 0; for (let i = items.length - 1; i >= 0; i--) if (drop(items[i])) { items.splice(i, 1); n++; } return n; },
  };
}
