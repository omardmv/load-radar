import type { Clock } from './clock.ts';

// Keys expire after ttlMs. Kept in time buckets; a whole bucket is dropped at once (cheap for GC).
export interface ExpiringMap<V> { get(k: string): V | undefined; set(k: string, v: V): void; has(k: string): boolean; size(): number }

export function createExpiringMap<V>(ttlMs: number, bucketMs: number, clock: Clock): ExpiringMap<V> {
  const buckets: { start: number; map: Map<string, V> }[] = [];
  const current = () => {
    const now = clock.now();
    while (buckets.length && buckets[0].start + bucketMs <= now - ttlMs) buckets.shift();
    let b = buckets[buckets.length - 1];
    if (!b || now >= b.start + bucketMs) { b = { start: now - (now % bucketMs), map: new Map() }; buckets.push(b); }
    return b;
  };
  const get = (k: string) => {
    current();
    for (let i = buckets.length - 1; i >= 0; i--) { const v = buckets[i].map.get(k); if (v !== undefined) return v; }
    return undefined;
  };
  return {
    get,
    has: (k) => get(k) !== undefined,
    set(k, v) { current().map.set(k, v); },
    size: () => buckets.reduce((n, b) => n + b.map.size, 0),
  };
}

export function createExpiringSet(ttlMs: number, bucketMs: number, clock: Clock) {
  const m = createExpiringMap<true>(ttlMs, bucketMs, clock);
  return { has: (k: string) => m.has(k), add: (k: string) => m.set(k, true), size: () => m.size() };
}
