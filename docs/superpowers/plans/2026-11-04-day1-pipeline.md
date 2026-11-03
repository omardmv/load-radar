# Load Radar Day 1: End-to-End Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Load Radar pipeline: simulated boards → scheduler and pollers (per-login budgets) → normalize → dedup → match (with entitlement) → alert queue → notifier → simulated Telegram, scored against the generator's answer key, with Prometheus metrics and sampled traces.

**Architecture:** One `engine` Node process holds all hot-path state in memory, with stages connected by bounded in-memory queues (no Redis, LLD §0). Two simulators (`boards-sim`, `telegram-sim`) replay the generated data on a shared *simulated clock* that can run faster than real time. A `scorer` compares delivered alerts with the answer key. Observability uses the measured configuration: lite metrics, sampling decided in our code, one span per posting.

**Tech Stack:** Node.js ≥ 22.6 running TypeScript directly (type stripping, no build step); `node:test` + `node:assert/strict` for tests; `undici` (HTTP client pools), `prom-client` (metrics), OpenTelemetry SDK (`@opentelemetry/sdk-trace-base`, `exporter-trace-otlp-http`); Docker Compose for OTel Collector, Prometheus, Grafana, Jaeger.

**Spec:** `DESIGN.md`, `LLD.md`, `OBSERVABILITY.md`, `bench/overhead/RESULTS.md` in this repo.

## Global Constraints

- Node.js ≥ 22.6 (developed on 26). Run `.ts` files directly with `node file.ts`. No TypeScript compiler, no bundler.
- **Type stripping rules:** every relative import ends in `.ts`; type-only imports use `import type` or the inline `type` keyword; no `enum`, no `namespace`, no constructor parameter properties.
- **No Redis or other shared store on the hot path** (LLD §0). State lives in memory, owned by one stage.
- **All times in the pipeline are simulated milliseconds since epoch** from a `Clock` (Task 1). Never call `Date.now()` for pipeline logic. Budgets and rate limits are defined per *simulated* minute or second.
- **Entitlement:** a posting fetched with a customer's login may alert only that customer (`visibleTo`).
- **Observability:** counters kept as plain numbers and flushed to prom-client once per batch; stage timings for 1 posting in 16; tracing sampled at 1% *by our code before the SDK*; at most one span per posting (RESULTS.md).
- **Metric labels:** never label by user, credential, search, load or chat.
- Out of scope for Day 1 (later plan): trained dedup classifier (a rule is used), search parser + LLM, snapshots and restart, dashboards and alert rules, load-test runs, SQLite (users are read from `searches.ndjson`).
- Dependencies already in `package.json`: `@opentelemetry/api`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/sdk-trace-base`, `prom-client`, `undici`. Add no others.
- Commit after every task with a conventional message; end each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File structure

```
src/
  shared/   types.ts clock.ts geo.ts heap.ts queue.ts bucket.ts expiring.ts semaphore.ts   + shared.test.ts
  data/     users.ts                                                                      + users.test.ts
  normalize/gazetteer.ts normalize.ts                                                     + normalize.test.ts
  dedup/    dedup.ts                                                                      + dedup.test.ts
  match/    filters.ts matcher.ts                                                         + match.test.ts
  alerts/   alert-queue.ts notifier.ts                                                    + alerts.test.ts
  plan/     heat.ts planner.ts                                                            + plan.test.ts
  schedule/ scheduler.ts                                                                  + scheduler.test.ts
  poll/     poller.ts                                                                     + poller.test.ts
  obs/      obs.ts                                                                        + obs.test.ts
  engine.ts                      wires everything; CLI
sims/       cover.ts boards-sim.ts telegram-sim.ts                                        + sims.test.ts
scorer/     score.ts                                                                      + score.test.ts
scripts/    run.ts               launches sims + engine, then scores
tests/      e2e.test.ts          generated mini dataset, full run
ops/        otel-collector.yaml prometheus.yml grafana/datasources.yaml
docker-compose.yml
```

---

### Task 1: Shared foundations (types, clock, geo, heap, queue, token bucket, expiring map, semaphore)

**Files:**
- Create: `src/shared/types.ts`, `src/shared/clock.ts`, `src/shared/geo.ts`, `src/shared/heap.ts`, `src/shared/queue.ts`, `src/shared/bucket.ts`, `src/shared/expiring.ts`, `src/shared/semaphore.ts`
- Test: `src/shared/shared.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces (used by every later task):
  - types: `Equip`, `Board`, `BOARDS`, `Dest`, `SearchSpec`, `Credential`, `User`, `PlanQuery`, `PlanEntry`, `Visibility`, `Place`, `Load`, `RawPosting`, `Alert`
  - `interface Clock { now(): number; sleep(simMs: number): Promise<void>; speed: number }`, `createSimClock({ simStart, speed, realStart? })`, `createFakeClock(start): Clock & { advance(ms): void }`
  - `geohash(lat, lon, precision): string`, `cellBounds(hash)`, `milesBetween(aLat, aLon, bLat, bLon): number`, `coverCells(lat, lon, radiusMi, precision): string[]`, `neighborCells(lat, lon, precision): string[]`, `centralDate(ms): string`, `daysBetween(fromDate, toDate): number`
  - `createHeap<T>(less)`, `createBoundedQueue<T>(capacity)`, `createTokenBucket(ratePerMin, burst, clock)`, `createExpiringMap<V>(ttlMs, bucketMs, clock)`, `createExpiringSet(ttlMs, bucketMs, clock)`, `createSemaphore(n)`

- [ ] **Step 1: Add test scripts to `package.json`**

Replace the `"scripts"` block with:

```json
  "scripts": {
    "test": "node --test \"src/**/*.test.ts\" \"sims/**/*.test.ts\" \"scorer/**/*.test.ts\"",
    "test:e2e": "node --test tests/e2e.test.ts",
    "gen": "node sim/gen.ts --loads 100000 --users 5000 --out out",
    "gen:small": "node sim/gen.ts --loads 8000 --users 300 --hours 2 --out out-small",
    "validate": "node sim/validate.ts out",
    "obs:up": "docker compose up -d",
    "obs:down": "docker compose down",
    "run": "node scripts/run.ts",
    "score": "node scorer/score.ts"
  },
```

- [ ] **Step 2: Write the failing tests**

`src/shared/shared.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from './clock.ts';
import { geohash, cellBounds, milesBetween, coverCells, neighborCells, centralDate, daysBetween } from './geo.ts';
import { createHeap } from './heap.ts';
import { createBoundedQueue } from './queue.ts';
import { createTokenBucket } from './bucket.ts';
import { createExpiringMap } from './expiring.ts';
import { createSemaphore } from './semaphore.ts';

test('geohash: Chicago is dp3wm at precision 5 and its cell contains the point', () => {
  const h = geohash(41.88, -87.63, 5);
  assert.equal(h, 'dp3wm');
  const b = cellBounds(h);
  assert.ok(b.latLo <= 41.88 && 41.88 <= b.latHi && b.lonLo <= -87.63 && -87.63 <= b.lonHi);
});

test('milesBetween: Chicago to Atlanta is about 587 miles', () => {
  const d = milesBetween(41.88, -87.63, 33.75, -84.39);
  assert.ok(d > 580 && d < 595, `got ${d}`);
});

test('coverCells: every point inside the radius falls in a covered cell (no misses)', () => {
  const lat0 = 41.88, lon0 = -87.63, radius = 75;
  const cells = new Set(coverCells(lat0, lon0, radius, 3));
  assert.ok(cells.size >= 4 && cells.size <= 12, `size ${cells.size}`);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 2000; i++) {
    const lat = lat0 + (rand() - 0.5) * 3, lon = lon0 + (rand() - 0.5) * 4;
    if (milesBetween(lat0, lon0, lat, lon) <= radius) assert.ok(cells.has(geohash(lat, lon, 3)), `missed ${lat},${lon}`);
  }
});

test('neighborCells returns the cell and its neighbors', () => {
  const n = neighborCells(41.88, -87.63, 4);
  assert.ok(n.includes(geohash(41.88, -87.63, 4)));
  assert.equal(n.length, 9);
});

test('centralDate and daysBetween use US Central (UTC-6)', () => {
  assert.equal(centralDate(Date.parse('2026-11-04T05:00:00Z')), '2026-11-03');
  assert.equal(centralDate(Date.parse('2026-11-04T07:00:00Z')), '2026-11-04');
  assert.equal(daysBetween('2026-11-04', '2026-11-06'), 2);
});

test('heap pops in order', () => {
  const h = createHeap<number>((a, b) => a < b);
  for (const x of [5, 1, 4, 2, 3]) h.push(x);
  const out: number[] = [];
  while (h.size()) out.push(h.pop()!);
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
});

test('bounded queue: tryPush refuses when full, push waits for space, batches report waits', async () => {
  const q = createBoundedQueue<number>(2);
  assert.ok(q.tryPush(1));
  assert.ok(q.tryPush(2));
  assert.equal(q.tryPush(3), false);
  let pushed = false;
  const p = q.push(3).then(() => { pushed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(pushed, false);
  const batch = q.takeBatch(1);
  assert.deepEqual(batch.items, [1]);
  assert.equal(batch.waitsMs.length, 1);
  await p;
  assert.equal(pushed, true);
  assert.deepEqual(q.takeBatch(10).items, [2, 3]);
});

test('token bucket refills on the simulated clock', () => {
  const clock = createFakeClock(0);
  const b = createTokenBucket(60, 2, clock);   // 1 token per simulated second, burst 2
  assert.ok(b.take());
  assert.ok(b.take());
  assert.equal(b.take(), false);
  assert.equal(b.nextTokenAt(), 1000);
  clock.advance(1000);
  assert.ok(b.take());
});

test('expiring map forgets keys after the TTL', () => {
  const clock = createFakeClock(0);
  const m = createExpiringMap<number>(10_000, 1_000, clock);
  m.set('a', 1);
  clock.advance(5_000);
  assert.equal(m.get('a'), 1);
  clock.advance(7_000);
  assert.equal(m.get('a'), undefined);
});

test('semaphore limits concurrency', async () => {
  const s = createSemaphore(1);
  await s.acquire();
  let second = false;
  const p = s.acquire().then(() => { second = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(second, false);
  assert.equal(s.waiting(), 1);
  s.release();
  await p;
  assert.equal(second, true);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test src/shared/shared.test.ts`
Expected: FAIL, `Cannot find module` for `./clock.ts`.

- [ ] **Step 4: Implement**

`src/shared/types.ts`:

```ts
export type Equip = 'van' | 'reefer' | 'flatbed';
export type Board = 'dat' | 'truckstop' | 'portal_a' | 'portal_b';
export const BOARDS: Board[] = ['dat', 'truckstop', 'portal_a', 'portal_b'];

export type Dest = { kind: 'anywhere' } | { kind: 'states'; states: string[] } | { kind: 'point'; lat: number; lon: number; radiusMi: number };

export interface SearchSpec {
  searchId: string; userId: string;
  lat: number; lon: number; deadheadMi: number;
  dest: Dest; equipment: Equip;
  minRpm: number | null; includeNoRate: boolean; pickupWithinDays: number;
}
export interface Credential { credentialId: string; userId: string; board: Board }
export interface User { userId: string; credentials: Credential[]; searches: SearchSpec[] }

export interface PlanQuery { lat: number; lon: number; radiusMi: number; equipment: Equip[] }
export interface PlanEntry {
  entryId: string; credentialId: string; userId: string; board: Board;
  query: PlanQuery; searchIds: string[];
  heat: number;        // expected new postings per simulated minute in the covered cells
  intervalMs: number;  // simulated ms between polls
  cursor: number;      // board time of the last successful poll (simulated ms)
}

export type Visibility = { kind: 'all' } | { kind: 'user'; userId: string };
export interface Place { city: string; state: string; lat: number; lon: number; cell4: string }
export interface Load {
  key: string; board: Board; boardLoadId: string; brokerMc: string;
  origin: Place; dest: Place; equipment: Equip; equipmentDetail: string;
  rate: number | null; miles: number; pickupDate: string;
  postedAt: number; contentHash: string; visibleTo: Visibility;
  canonicalId: string;   // '' until dedup assigns it
}
export interface RawPosting { board: Board; credentialId: string | null; userId: string | null; entryId: string | null; fetchedAt: number; raw: unknown }
export interface Alert { userId: string; canonicalId: string; loadKey: string; searchIds: string[]; summary: string; postedAt: number; enqueuedAt: number }
```

`src/shared/clock.ts`:

```ts
// Simulated time. Every pipeline timestamp is simulated ms since epoch; `speed` real-to-simulated.
export interface Clock { now(): number; sleep(simMs: number): Promise<void>; speed: number }

export function createSimClock(opts: { simStart: number; speed: number; realStart?: number }): Clock {
  const realStart = opts.realStart ?? Date.now();
  return {
    speed: opts.speed,
    now: () => opts.simStart + (Date.now() - realStart) * opts.speed,
    sleep: (simMs) => new Promise((r) => setTimeout(r, Math.max(0, simMs / opts.speed))),
  };
}

export function createFakeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  const waiters: { at: number; resolve: () => void }[] = [];
  return {
    speed: 1,
    now: () => t,
    sleep: (ms) => new Promise<void>((resolve) => { waiters.push({ at: t + ms, resolve }); }),
    advance(ms) {
      t += ms;
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].at <= t) { waiters[i].resolve(); waiters.splice(i, 1); }
    },
  };
}
```

`src/shared/geo.ts`:

```ts
const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const R = Math.PI / 180;

export function geohash(lat: number, lon: number, precision: number): string {
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180, out = '', bit = 0, ch = 0, even = true;
  while (out.length < precision) {
    if (even) { const m = (lonLo + lonHi) / 2; if (lon >= m) { ch = ch * 2 + 1; lonLo = m; } else { ch *= 2; lonHi = m; } }
    else { const m = (latLo + latHi) / 2; if (lat >= m) { ch = ch * 2 + 1; latLo = m; } else { ch *= 2; latHi = m; } }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

export function cellBounds(hash: string) {
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180, even = true;
  for (const c of hash) {
    const v = B32.indexOf(c);
    for (let b = 4; b >= 0; b--) {
      const bit = (v >> b) & 1;
      if (even) { const m = (lonLo + lonHi) / 2; if (bit) lonLo = m; else lonHi = m; }
      else { const m = (latLo + latHi) / 2; if (bit) latLo = m; else latHi = m; }
      even = !even;
    }
  }
  return { latLo, latHi, lonLo, lonHi };
}

export function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const h = Math.sin((bLat - aLat) * R / 2) ** 2 + Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin((bLon - aLon) * R / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

const cellSize = (precision: number) => {
  const bits = precision * 5;
  return { dlat: 180 / 2 ** Math.floor(bits / 2), dlon: 360 / 2 ** Math.ceil(bits / 2) };
};

// Every cell whose rectangle comes within radiusMi of the point (nearest point of the cell <= radius).
export function coverCells(lat: number, lon: number, radiusMi: number, precision: number): string[] {
  const { dlat, dlon } = cellSize(precision);
  const spanLat = radiusMi / 69 + dlat;
  const spanLon = radiusMi / (69 * Math.max(0.2, Math.cos(lat * R))) + dlon;
  const cells = new Set<string>();
  const out: string[] = [];
  for (let la = lat - spanLat; la <= lat + spanLat + dlat / 2; la += dlat / 2) {
    for (let lo = lon - spanLon; lo <= lon + spanLon + dlon / 2; lo += dlon / 2) {
      const h = geohash(Math.max(-90, Math.min(89.9999, la)), ((lo + 540) % 360) - 180, precision);
      if (cells.has(h)) continue;
      cells.add(h);
      const b = cellBounds(h);
      const nLat = Math.min(Math.max(lat, b.latLo), b.latHi), nLon = Math.min(Math.max(lon, b.lonLo), b.lonHi);
      if (milesBetween(lat, lon, nLat, nLon) <= radiusMi) out.push(h);
    }
  }
  return out;
}

export function neighborCells(lat: number, lon: number, precision: number): string[] {
  const { dlat, dlon } = cellSize(precision);
  const out = new Set<string>();
  for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) out.add(geohash(lat + a * dlat, lon + b * dlon, precision));
  return [...out];
}

export const centralDate = (ms: number): string => new Date(ms - 6 * 3_600_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
```

`src/shared/heap.ts`:

```ts
export interface Heap<T> { push(x: T): void; pop(): T | undefined; peek(): T | undefined; size(): number }

export function createHeap<T>(less: (a: T, b: T) => boolean): Heap<T> {
  const a: T[] = [];
  const up = (i: number) => { while (i > 0) { const p = (i - 1) >> 1; if (!less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; } };
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < a.length && less(a[l], a[m])) m = l;
      if (r < a.length && less(a[r], a[m])) m = r;
      if (m === i) return;
      [a[i], a[m]] = [a[m], a[i]]; i = m;
    }
  };
  return {
    push(x) { a.push(x); up(a.length - 1); },
    pop() { if (!a.length) return undefined; const top = a[0]; const last = a.pop()!; if (a.length) { a[0] = last; down(0); } return top; },
    peek: () => a[0],
    size: () => a.length,
  };
}
```

`src/shared/queue.ts`:

```ts
// Bounded FIFO between stages. A full queue makes producers wait (backpressure) or refuse (tryPush).
export interface BoundedQueue<T> {
  capacity: number;
  tryPush(item: T): boolean;
  push(item: T): Promise<void>;
  takeBatch(max: number): { items: T[]; waitsMs: number[] };
  waitForItems(): Promise<void>;
  size(): number;
}

export function createBoundedQueue<T>(capacity: number): BoundedQueue<T> {
  let items: T[] = [];
  let at: number[] = [];
  let head = 0;
  const spaceWaiters: (() => void)[] = [];
  const itemWaiters: (() => void)[] = [];
  const size = () => items.length - head;
  const wake = (ws: (() => void)[]) => { for (const f of ws.splice(0)) f(); };
  const add = (x: T) => { items.push(x); at.push(performance.now()); wake(itemWaiters); };
  return {
    capacity,
    tryPush(x) { if (size() >= capacity) return false; add(x); return true; },
    async push(x) { while (size() >= capacity) await new Promise<void>((r) => spaceWaiters.push(r)); add(x); },
    takeBatch(max) {
      const n = Math.min(max, size());
      const now = performance.now();
      const out = items.slice(head, head + n);
      const waitsMs = at.slice(head, head + n).map((t) => now - t);
      head += n;
      if (head > 4096 && head * 2 > items.length) { items = items.slice(head); at = at.slice(head); head = 0; }
      if (n) wake(spaceWaiters);
      return { items: out, waitsMs };
    },
    waitForItems() { return size() > 0 ? Promise.resolve() : new Promise<void>((r) => itemWaiters.push(r)); },
    size,
  };
}
```

`src/shared/bucket.ts`:

```ts
import type { Clock } from './clock.ts';

export interface TokenBucket { take(): boolean; nextTokenAt(): number; setRatePerMin(r: number): void; ratePerMin(): number }

// Token bucket on simulated time: `ratePerMin` tokens per simulated minute, at most `burst` saved up.
export function createTokenBucket(ratePerMin: number, burst: number, clock: Clock): TokenBucket {
  let rate = ratePerMin;
  let tokens = burst;
  let last = clock.now();
  const refill = () => { const now = clock.now(); tokens = Math.min(burst, tokens + ((now - last) / 60_000) * rate); last = now; };
  return {
    take() { refill(); if (tokens >= 1) { tokens -= 1; return true; } return false; },
    nextTokenAt() { refill(); return tokens >= 1 ? clock.now() : clock.now() + Math.ceil(((1 - tokens) / rate) * 60_000); },
    setRatePerMin(r) { refill(); rate = r; },
    ratePerMin: () => rate,
  };
}
```

`src/shared/expiring.ts`:

```ts
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
```

`src/shared/semaphore.ts`:

```ts
export interface Semaphore { acquire(): Promise<void>; release(): void; inUse(): number; waiting(): number }

export function createSemaphore(n: number): Semaphore {
  let used = 0;
  const queue: (() => void)[] = [];
  return {
    acquire() { if (used < n) { used++; return Promise.resolve(); } return new Promise<void>((r) => queue.push(r)); },
    release() { const next = queue.shift(); if (next) next(); else used--; },
    inUse: () => used,
    waiting: () => queue.length,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test src/shared/shared.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json src/shared
git commit -m "feat(shared): clock, geo, heap, queue, token bucket, expiring map, semaphore"
```

---

### Task 2: Users loader and normalizer (4 board formats → `Load`)

**Files:**
- Create: `src/data/users.ts`, `src/normalize/gazetteer.ts`, `src/normalize/normalize.ts`
- Test: `src/data/users.test.ts`, `src/normalize/normalize.test.ts`

**Interfaces:**
- Consumes: types, `geohash`, `milesBetween` (Task 1)
- Produces:
  - `loadUsers(searchesFile: string): User[]`
  - `loadGazetteer(dataDir: string): (city: string, state: string) => { city: string; state: string; lat: number; lon: number } | null`
  - `createNormalizer(lookup): (r: RawPosting) => { ok: true; load: Load } | { ok: false; reason: 'place' | 'equipment' }`
  - `rawId(board: Board, raw: any): string`

- [ ] **Step 1: Write the failing tests**

`src/data/users.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadUsers } from './users.ts';

test('loadUsers maps generator searches to SearchSpec', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-'));
  const line = { user_id: 'U1', home: 'Chicago', credentials: [{ board: 'dat', credential_id: 'dat-1' }],
    searches: [
      { search_id: 'S1', origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63 }, deadhead_mi: 75, dest: { kind: 'market', city: 'Atlanta', state: 'GA', lat: 33.75, lon: -84.39, radius_mi: 150 }, equipment: 'van', min_rpm: 2.8, pickup_within_days: 2, text: 'x' },
      { search_id: 'S2', origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63 }, deadhead_mi: 50, dest: { kind: 'anywhere' }, equipment: 'reefer', min_rpm: null, pickup_within_days: 0, text: 'y' },
    ] };
  writeFileSync(join(dir, 'searches.ndjson'), JSON.stringify(line) + '\n');
  const [u] = loadUsers(join(dir, 'searches.ndjson'));
  assert.equal(u.userId, 'U1');
  assert.deepEqual(u.credentials, [{ credentialId: 'dat-1', userId: 'U1', board: 'dat' }]);
  assert.deepEqual(u.searches[0].dest, { kind: 'point', lat: 33.75, lon: -84.39, radiusMi: 150 });
  assert.equal(u.searches[0].includeNoRate, true);
  assert.equal(u.searches[1].minRpm, null);
});
```

`src/normalize/normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGazetteer } from './gazetteer.ts';
import { createNormalizer } from './normalize.ts';
import type { RawPosting } from '../shared/types.ts';

const lookup = loadGazetteer(join(dirname(fileURLToPath(import.meta.url)), '../../sim/data'));
const normalize = createNormalizer(lookup);
const raw = (board: RawPosting['board'], r: unknown, userId: string | null = 'U1'): RawPosting =>
  ({ board, credentialId: userId ? 'c1' : null, userId, entryId: 'e1', fetchedAt: 0, raw: r });

test('dat format', () => {
  const r = normalize(raw('dat', { id: 'DAT-1', origin: 'Chicago, IL', dest: 'Atlanta, GA', equip: 'V', rate: 1950, trip_mi: 716, weight_lbs: 40000, pickup: '2026-11-04', posted: '2026-11-04T15:00:00.000Z', comments: '', company: { name: 'X', mc: '123' } }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.load.key, 'dat:DAT-1');
  assert.equal(r.load.equipment, 'van');
  assert.equal(r.load.rate, 1950);
  assert.equal(r.load.miles, 716);
  assert.equal(r.load.origin.cell4, 'dp3w');
  assert.equal(r.load.postedAt, Date.parse('2026-11-04T15:00:00.000Z'));
  assert.deepEqual(r.load.visibleTo, { kind: 'user', userId: 'U1' });
  assert.equal(r.load.canonicalId, '');
});

test('truckstop format: upper case, names cut at 14 characters, "$0" means no rate', () => {
  const r = normalize(raw('truckstop', { loadId: 55, originCity: 'BILLINGTON HEI', originState: 'NY', destinationCity: 'CHICAGO', destinationState: 'IL', equipmentType: 'FLATBED/STEP DECK', paymentAmount: '$0', mileage: 520, weight: '44,000 lbs', pickupDate: '11/05/2026', postedAt: 1793800000000, specInfo: '', broker: { companyName: 'Y', mcNumber: 'MC777' } }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.load.origin.city, 'Billington Heights');
  assert.equal(r.load.rate, null);
  assert.equal(r.load.equipment, 'flatbed');
  assert.equal(r.load.brokerMc, '777');
  assert.equal(r.load.pickupDate, '2026-11-05');
});

test('portal_a and portal_b formats; portal_b weight is in thousands', () => {
  const a = normalize(raw('portal_a', { ref: 'PA1', lane: { from: { city: 'St Louis', st: 'MO' }, to: { city: 'Dallas', st: 'TX' } }, mode: "Reefer 53'", price: { amount: 2100, currency: 'USD' }, pu: { earliest: '2026-11-04T06:00:00-06:00', latest: '2026-11-04T18:00:00-06:00' }, created: '2026-11-04T12:00:00.000Z', notes: '', broker_mc: '9' }));
  assert.ok(a.ok);
  if (a.ok) { assert.equal(a.load.origin.city, 'St. Louis'); assert.equal(a.load.equipment, 'reefer'); assert.ok(a.load.miles > 500); }
  const b = normalize(raw('portal_b', { ref: 'PB1', pickup_date: '11-04-2026', origin: 'LA, CA', destination: 'PHOENIX, AZ', equipment: 'Van', rate: '$1,200', weight: '38.00 lbs', size: 'Full', company: 'Z', mc: '5', details: '', created_at: 1793800000 }, null));
  assert.ok(b.ok);
  if (b.ok) { assert.equal(b.load.origin.city, 'Los Angeles'); assert.equal(b.load.rate, 1200); assert.deepEqual(b.load.visibleTo, { kind: 'all' }); assert.equal(b.load.postedAt, 1793800000000); }
});

test('unknown place and unknown equipment are rejected with a reason', () => {
  const p = normalize(raw('dat', { id: 'D2', origin: 'Nowhereville, ZZ', dest: 'Atlanta, GA', equip: 'V', rate: 1, trip_mi: 1, weight_lbs: 1, pickup: '2026-11-04', posted: '2026-11-04T15:00:00Z', comments: '', company: { name: 'X', mc: '1' } }));
  assert.deepEqual(p, { ok: false, reason: 'place' });
  const e = normalize(raw('dat', { id: 'D3', origin: 'Chicago, IL', dest: 'Atlanta, GA', equip: 'TANKER', rate: 1, trip_mi: 1, weight_lbs: 1, pickup: '2026-11-04', posted: '2026-11-04T15:00:00Z', comments: '', company: { name: 'X', mc: '1' } }));
  assert.deepEqual(e, { ok: false, reason: 'equipment' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/data/users.test.ts src/normalize/normalize.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/data/users.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { Board, Dest, Equip, User } from '../shared/types.ts';

// Reads sim/gen.ts searches.ndjson. (Production keeps users in a database on the cold path.)
export function loadUsers(searchesFile: string): User[] {
  const users: User[] = [];
  for (const line of readFileSync(searchesFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const u = JSON.parse(line);
    users.push({
      userId: u.user_id,
      credentials: u.credentials.map((c: { board: Board; credential_id: string }) => ({ credentialId: c.credential_id, userId: u.user_id, board: c.board })),
      searches: u.searches.map((s: any) => {
        const dest: Dest = s.dest.kind === 'market' ? { kind: 'point', lat: s.dest.lat, lon: s.dest.lon, radiusMi: s.dest.radius_mi }
          : s.dest.kind === 'states' ? { kind: 'states', states: s.dest.states } : { kind: 'anywhere' };
        return { searchId: s.search_id, userId: u.user_id, lat: s.origin.lat, lon: s.origin.lon, deadheadMi: s.deadhead_mi, dest,
          equipment: s.equipment as Equip, minRpm: s.min_rpm, includeNoRate: true, pickupWithinDays: s.pickup_within_days };
      }),
    });
  }
  return users;
}
```

`src/normalize/gazetteer.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PlaceHit = { city: string; state: string; lat: number; lon: number };
const norm = (s: string) => s.toUpperCase().replace(/[.,']/g, '').replace(/^SAINT /, 'ST ').replace(/^FORT /, 'FT ').replace(/^MOUNT /, 'MT ').replace(/\s+/g, ' ').trim();
const ALIASES: Record<string, string> = { 'LA': 'LOS ANGELES', 'VERNON': 'LOS ANGELES', 'KANSAS CTY': 'KANSAS CITY', 'ONTARIO (INLAND EMPIRE)': 'ONTARIO' };

// Place lookup (LLD 6.5): exact, aliases, 14-character truncation. Built once in memory.
export function loadGazetteer(dataDir: string): (city: string, state: string) => PlaceHit | null {
  const exact = new Map<string, PlaceHit>();
  const byState = new Map<string, [string, PlaceHit][]>();
  const add = (city: string, state: string, lat: number, lon: number) => {
    const k = `${norm(city)}|${state}`;
    if (exact.has(k)) return;
    const p = { city, state, lat, lon };
    exact.set(k, p);
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state)!.push([norm(city), p]);
  };
  for (const m of JSON.parse(readFileSync(join(dataDir, 'markets.json'), 'utf8')).markets) add(m.city, m.state, m.lat, m.lon);
  for (const t of JSON.parse(readFileSync(join(dataDir, 'towns.json'), 'utf8')).towns) add(t.name, t.state, t.lat, t.lon);
  return (city, state) => {
    let n = norm(city);
    n = ALIASES[n] ?? n;
    const hit = exact.get(`${n}|${state}`);
    if (hit) return hit;
    if (n.length === 14) for (const [name, p] of byState.get(state) ?? []) if (name.startsWith(n)) return p;
    return null;
  };
}
```

`src/normalize/normalize.ts`:

```ts
import { createHash } from 'node:crypto';
import { geohash, milesBetween } from '../shared/geo.ts';
import type { Board, Equip, Load, RawPosting } from '../shared/types.ts';
import type { PlaceHit } from './gazetteer.ts';

const EQUIP: Record<string, Equip> = {
  V: 'van', VR: 'van', R: 'reefer', F: 'flatbed', FD: 'flatbed', VAN: 'van', 'VAN/REEFER': 'van', REEFER: 'reefer', FLATBED: 'flatbed',
  'STEP DECK': 'flatbed', 'FLATBED/STEP DECK': 'flatbed', 'FLATBED (W/TARPS)': 'flatbed', "DRY VAN 53'": 'van', "REEFER 53'": 'reefer',
  "FLATBED 48'": 'flatbed', "STEP DECK 48'": 'flatbed',
};
const money = (s: unknown): number | null => {
  if (s == null || s === '') return null;
  const n = typeof s === 'number' ? s : Number(String(s).replace(/[$,]/g, ''));
  return n > 0 ? n : null;
};
const splitPlace = (s: string) => { const i = s.lastIndexOf(','); return [s.slice(0, i).trim(), s.slice(i + 1).trim()]; };
const mdy = (s: string, sep: string) => { const [m, d, y] = s.split(sep); return `${y}-${m}-${d}`; };

export function rawId(board: Board, raw: any): string {
  return board === 'dat' ? raw.id : board === 'truckstop' ? String(raw.loadId) : raw.ref;
}

export type NormalizeResult = { ok: true; load: Load } | { ok: false; reason: 'place' | 'equipment' };

export function createNormalizer(lookup: (city: string, state: string) => PlaceHit | null) {
  return (p: RawPosting): NormalizeResult => {
    const r: any = p.raw;
    let oc: string, os: string, dc: string, ds: string, eq: string, rate: number | null, pickup: string, posted: number, mc: string, mi: number | null = null, detail: string;
    switch (p.board) {
      case 'dat': [oc, os] = splitPlace(r.origin); [dc, ds] = splitPlace(r.dest); eq = r.equip; rate = money(r.rate); pickup = r.pickup; posted = Date.parse(r.posted); mc = r.company.mc; mi = r.trip_mi; detail = r.equip; break;
      case 'truckstop': oc = r.originCity; os = r.originState; dc = r.destinationCity; ds = r.destinationState; eq = r.equipmentType; rate = money(r.paymentAmount); pickup = mdy(r.pickupDate, '/'); posted = r.postedAt; mc = String(r.broker.mcNumber).replace(/^MC/, ''); mi = r.mileage; detail = r.equipmentType; break;
      case 'portal_a': oc = r.lane.from.city; os = r.lane.from.st; dc = r.lane.to.city; ds = r.lane.to.st; eq = r.mode; rate = money(r.price?.amount); pickup = r.pu.earliest.slice(0, 10); posted = Date.parse(r.created); mc = r.broker_mc; detail = r.mode; break;
      default: [oc, os] = splitPlace(r.origin); [dc, ds] = splitPlace(r.destination); eq = r.equipment; rate = money(r.rate); pickup = mdy(r.pickup_date, '-'); posted = r.created_at * 1000; mc = r.mc; detail = r.equipment;
    }
    const equipment = EQUIP[String(eq).toUpperCase()];
    if (!equipment) return { ok: false, reason: 'equipment' };
    const o = lookup(oc, os), d = lookup(dc, ds);
    if (!o || !d) return { ok: false, reason: 'place' };
    const id = rawId(p.board, r);
    const miles = mi ?? Math.round(milesBetween(o.lat, o.lon, d.lat, d.lon) * 1.17);
    const contentHash = createHash('sha1').update(`${p.board}|${id}|${rate}|${pickup}|${o.city}|${d.city}|${equipment}`).digest('base64');
    return { ok: true, load: {
      key: `${p.board}:${id}`, board: p.board, boardLoadId: id, brokerMc: String(mc),
      origin: { ...o, cell4: geohash(o.lat, o.lon, 4) }, dest: { ...d, cell4: geohash(d.lat, d.lon, 4) },
      equipment, equipmentDetail: String(detail), rate, miles, pickupDate: pickup, postedAt: posted, contentHash,
      visibleTo: p.userId ? { kind: 'user', userId: p.userId } : { kind: 'all' }, canonicalId: '',
    } };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/data/users.test.ts src/normalize/normalize.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data src/normalize
git commit -m "feat(normalize): users loader, gazetteer and four board adapters"
```

---

### Task 3: Dedup (exact stage + same-load rule)

**Files:**
- Create: `src/dedup/dedup.ts`
- Test: `src/dedup/dedup.test.ts`

**Interfaces:**
- Consumes: `Load`, `Clock`, `createExpiringMap`, `neighborCells`
- Produces: `createDedup(clock: Clock): (l: Load) => { result: 'refresh' | 'updated' | 'merged' | 'new'; canonicalId: string; candidates: number }`. It sets `l.canonicalId`.

The same-load *rule* stands in for the trained classifier (Day 2). Rule: same broker → same load if posted within 6 h and rates within 13% (or either rate missing). Different broker → same load only as a co-broker copy: both rates present, second rate 85–97% of the first, posted within 1 h.

- [ ] **Step 1: Write the failing test**

`src/dedup/dedup.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from '../shared/clock.ts';
import { createDedup } from './dedup.ts';
import type { Load } from '../shared/types.ts';

const T0 = Date.parse('2026-11-04T15:00:00Z');
const base = (over: Partial<Load> = {}): Load => ({
  key: 'dat:1', board: 'dat', boardLoadId: '1', brokerMc: '100',
  origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63, cell4: 'dp3w' },
  dest: { city: 'Atlanta', state: 'GA', lat: 33.75, lon: -84.39, cell4: 'dn5b' },
  equipment: 'van', equipmentDetail: 'V', rate: 1950, miles: 716, pickupDate: '2026-11-04',
  postedAt: T0, contentHash: 'h1', visibleTo: { kind: 'all' }, canonicalId: '', ...over,
});

test('same posting seen again is a refresh; edited posting is an update of the same canonical load', () => {
  const dedup = createDedup(createFakeClock(T0));
  const first = dedup(base());
  assert.equal(first.result, 'new');
  assert.equal(dedup(base()).result, 'refresh');
  const upd = dedup(base({ contentHash: 'h2', rate: 2000 }));
  assert.equal(upd.result, 'updated');
  assert.equal(upd.canonicalId, first.canonicalId);
});

test('cross-post on another board by the same broker merges', () => {
  const dedup = createDedup(createFakeClock(T0));
  const a = dedup(base());
  const b = dedup(base({ key: 'truckstop:9', board: 'truckstop', boardLoadId: '9', contentHash: 'x', rate: 1975, postedAt: T0 + 90_000 }));
  assert.equal(b.result, 'merged');
  assert.equal(b.canonicalId, a.canonicalId);
});

test('co-broker copy at a lower rate merges; a different broker at the same rate does not', () => {
  const dedup = createDedup(createFakeClock(T0));
  const a = dedup(base());
  const co = dedup(base({ key: 'dat:2', boardLoadId: '2', brokerMc: '200', contentHash: 'y', rate: 1800, postedAt: T0 + 600_000 }));
  assert.equal(co.result, 'merged');
  assert.equal(co.canonicalId, a.canonicalId);
  const other = dedup(base({ key: 'dat:3', boardLoadId: '3', brokerMc: '300', contentHash: 'z', rate: 1950, postedAt: T0 + 600_000 }));
  assert.equal(other.result, 'new');
});

test('recurring freight on the next pickup day is a separate load', () => {
  const dedup = createDedup(createFakeClock(T0));
  const a = dedup(base());
  const sib = dedup(base({ key: 'dat:4', boardLoadId: '4', contentHash: 'w', pickupDate: '2026-11-05', postedAt: T0 + 60_000 }));
  assert.equal(sib.result, 'new');
  assert.notEqual(sib.canonicalId, a.canonicalId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/dedup/dedup.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/dedup/dedup.ts`:

```ts
import type { Clock } from '../shared/clock.ts';
import { createExpiringMap } from '../shared/expiring.ts';
import { neighborCells } from '../shared/geo.ts';
import type { Load } from '../shared/types.ts';

type Seen = { hash: string; canonicalId: string };
type Entry = { canonicalId: string; rate: number | null; brokerMc: string; postedAt: number };
export type DedupResult = { result: 'refresh' | 'updated' | 'merged' | 'new'; canonicalId: string; candidates: number };

const HOUR = 3_600_000;
const TTL = 72 * HOUR;

// Stand-in for the trained classifier (LLD 6.6). Same broker: rate within 13% and 6 h. Different broker:
// a co-broker copy (85–97% of the rate, within 1 h).
function sameLoad(c: Entry, l: Load): boolean {
  const dt = Math.abs(c.postedAt - l.postedAt);
  if (c.brokerMc === l.brokerMc) return dt <= 6 * HOUR && (c.rate === null || l.rate === null || Math.abs(c.rate - l.rate) / c.rate <= 0.13);
  if (c.rate === null || l.rate === null || dt > HOUR) return false;
  const ratio = l.rate / c.rate;
  return ratio >= 0.85 && ratio <= 0.97;
}

export function createDedup(clock: Clock) {
  const seen = createExpiringMap<Seen>(TTL, HOUR, clock);
  const blocks = createExpiringMap<Entry[]>(TTL, HOUR, clock);
  let next = 1;
  return (l: Load): DedupResult => {
    const prev = seen.get(l.key);
    if (prev) {
      l.canonicalId = prev.canonicalId;
      if (prev.hash === l.contentHash) return { result: 'refresh', canonicalId: prev.canonicalId, candidates: 0 };
      seen.set(l.key, { hash: l.contentHash, canonicalId: prev.canonicalId });
      return { result: 'updated', canonicalId: prev.canonicalId, candidates: 0 };
    }
    let candidates = 0;
    for (const oc of neighborCells(l.origin.lat, l.origin.lon, 4)) {
      const list = blocks.get(`${l.pickupDate}|${oc}|${l.dest.cell4}|${l.equipment}`);
      if (!list) continue;
      for (const c of list) {
        candidates++;
        if (!sameLoad(c, l)) continue;
        l.canonicalId = c.canonicalId;
        seen.set(l.key, { hash: l.contentHash, canonicalId: c.canonicalId });
        return { result: 'merged', canonicalId: c.canonicalId, candidates };
      }
    }
    l.canonicalId = `C${next++}`;
    seen.set(l.key, { hash: l.contentHash, canonicalId: l.canonicalId });
    const k = `${l.pickupDate}|${l.origin.cell4}|${l.dest.cell4}|${l.equipment}`;
    const list = blocks.get(k);
    const entry = { canonicalId: l.canonicalId, rate: l.rate, brokerMc: l.brokerMc, postedAt: l.postedAt };
    if (list) list.push(entry); else blocks.set(k, [entry]);
    return { result: 'new', canonicalId: l.canonicalId, candidates };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/dedup/dedup.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/dedup
git commit -m "feat(dedup): exact stage and same-load rule (classifier stand-in)"
```

---

### Task 4: Matcher (filters + geohash level-3 index + entitlement)

**Files:**
- Create: `src/match/filters.ts`, `src/match/matcher.ts`
- Test: `src/match/match.test.ts`

**Interfaces:**
- Consumes: `SearchSpec`, `Load`, `coverCells`, `milesBetween`, `centralDate`, `daysBetween`
- Produces:
  - `type MatchableLoad = Pick<Load, 'origin' | 'dest' | 'equipment' | 'rate' | 'miles' | 'pickupDate' | 'postedAt'>`
  - `specMatches(s: SearchSpec, l: MatchableLoad): boolean` (also used by the scorer)
  - `buildMatcher(specs: SearchSpec[]): { indexEntries: number; match(l: Load): { candidates: number; users: Map<string, string[]> } }`

- [ ] **Step 1: Write the failing test**

`src/match/match.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specMatches } from './filters.ts';
import { buildMatcher } from './matcher.ts';
import { geohash } from '../shared/geo.ts';
import type { Load, SearchSpec } from '../shared/types.ts';

const T0 = Date.parse('2026-11-04T15:00:00Z');
const spec = (over: Partial<SearchSpec> = {}): SearchSpec => ({
  searchId: 'S1', userId: 'U1', lat: 41.88, lon: -87.63, deadheadMi: 75, dest: { kind: 'anywhere' },
  equipment: 'van', minRpm: null, includeNoRate: true, pickupWithinDays: 2, ...over,
});
const load = (over: Partial<Load> = {}): Load => ({
  key: 'dat:1', board: 'dat', boardLoadId: '1', brokerMc: '1',
  origin: { city: 'Joliet', state: 'IL', lat: 41.53, lon: -88.08, cell4: 'dp3q' },
  dest: { city: 'Atlanta', state: 'GA', lat: 33.75, lon: -84.39, cell4: 'dn5b' },
  equipment: 'van', equipmentDetail: 'V', rate: 2150, miles: 716, pickupDate: '2026-11-04', postedAt: T0,
  contentHash: 'h', visibleTo: { kind: 'all' }, canonicalId: 'C1', ...over,
});

test('filters: deadhead, destination, rate floor, no-rate, pickup window, equipment', () => {
  assert.ok(specMatches(spec(), load()));
  assert.equal(specMatches(spec({ deadheadMi: 20 }), load()), false);
  assert.equal(specMatches(spec({ dest: { kind: 'states', states: ['TX'] } }), load()), false);
  assert.ok(specMatches(spec({ dest: { kind: 'states', states: ['GA'] } }), load()));
  assert.equal(specMatches(spec({ minRpm: 3.5 }), load()), false);          // 2150 / 716 = 3.00
  assert.ok(specMatches(spec({ minRpm: 3.5 }), load({ rate: null })));      // no rate: included by default
  assert.equal(specMatches(spec({ minRpm: 3.5, includeNoRate: false }), load({ rate: null })), false);
  assert.equal(specMatches(spec({ pickupWithinDays: 0 }), load({ pickupDate: '2026-11-05' })), false);
  assert.equal(specMatches(spec({ equipment: 'reefer' }), load()), false);
});

test('matcher finds exactly what brute force finds, and applies entitlement', () => {
  const specs: SearchSpec[] = [];
  let seed = 3;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 400; i++) specs.push(spec({ searchId: `S${i}`, userId: `U${i % 50}`, lat: 41 + rand() * 2, lon: -89 + rand() * 3, deadheadMi: [50, 75, 100, 150][i % 4] }));
  const m = buildMatcher(specs);
  for (let i = 0; i < 200; i++) {
    const lat = 41 + rand() * 2, lon = -89 + rand() * 3;
    const l = load({ origin: { city: 'X', state: 'IL', lat, lon, cell4: geohash(lat, lon, 4) } });
    const got = m.match(l).users;
    const want = new Set(specs.filter((s) => specMatches(s, l)).map((s) => s.userId));
    assert.deepEqual(new Set(got.keys()), want);
  }
  const gated = load({ visibleTo: { kind: 'user', userId: 'U1' } });
  for (const userId of m.match(gated).users.keys()) assert.equal(userId, 'U1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/match/match.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/match/filters.ts`:

```ts
import { centralDate, daysBetween, milesBetween } from '../shared/geo.ts';
import type { Load, SearchSpec } from '../shared/types.ts';

export type MatchableLoad = Pick<Load, 'origin' | 'dest' | 'equipment' | 'rate' | 'miles' | 'pickupDate' | 'postedAt'>;

// Exact filters (LLD 6.7). The pickup window is measured from the load's posting date (US Central).
export function specMatches(s: SearchSpec, l: MatchableLoad): boolean {
  if (s.equipment !== l.equipment) return false;
  if (milesBetween(s.lat, s.lon, l.origin.lat, l.origin.lon) > s.deadheadMi) return false;
  if (s.dest.kind === 'states' && !s.dest.states.includes(l.dest.state)) return false;
  if (s.dest.kind === 'point' && milesBetween(s.dest.lat, s.dest.lon, l.dest.lat, l.dest.lon) > s.dest.radiusMi) return false;
  if (l.rate === null) { if (!s.includeNoRate) return false; }
  else if (s.minRpm !== null && l.rate / l.miles < s.minRpm) return false;
  const d = daysBetween(centralDate(l.postedAt), l.pickupDate);
  return d >= 0 && d <= s.pickupWithinDays;
}
```

`src/match/matcher.ts`:

```ts
import { coverCells } from '../shared/geo.ts';
import type { Load, SearchSpec } from '../shared/types.ts';
import { specMatches } from './filters.ts';

// Index: geohash level-3 cell + equipment -> searches whose deadhead circle touches the cell (LLD 6.7).
export function buildMatcher(specs: SearchSpec[]) {
  const index = new Map<string, SearchSpec[]>();
  let indexEntries = 0;
  for (const s of specs) {
    for (const c of coverCells(s.lat, s.lon, s.deadheadMi, 3)) {
      const k = `${c}|${s.equipment}`;
      const list = index.get(k);
      if (list) list.push(s); else index.set(k, [s]);
      indexEntries++;
    }
  }
  return {
    indexEntries,
    match(l: Load): { candidates: number; users: Map<string, string[]> } {
      const cands = index.get(`${l.origin.cell4.slice(0, 3)}|${l.equipment}`) ?? [];
      const users = new Map<string, string[]>();
      const onlyUser = l.visibleTo.kind === 'user' ? l.visibleTo.userId : null;
      for (const s of cands) {
        if (onlyUser !== null && s.userId !== onlyUser) continue;     // entitlement
        if (!specMatches(s, l)) continue;
        const list = users.get(s.userId);
        if (list) list.push(s.searchId); else users.set(s.userId, [s.searchId]);
      }
      return { candidates: cands.length, users };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/match/match.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/match
git commit -m "feat(match): exact filters and geohash level-3 matcher with entitlement"
```

---

### Task 5: Alert queue and notifier

**Files:**
- Create: `src/alerts/alert-queue.ts`, `src/alerts/notifier.ts`
- Test: `src/alerts/alerts.test.ts`

**Interfaces:**
- Consumes: `Alert`, `Clock`, `createExpiringSet`, `createTokenBucket`
- Produces:
  - `createAlertQueue(opts: { clock: Clock; freshAfterMs: number; deadlineMs: number; ttlMs: number }): AlertQueue` with `offer(a: Alert): boolean`, `take(max: number): { alerts: Alert[]; mode: 'oldest' | 'freshest' }`, `size(): number`, `dropped(): number`, `oldestWaitMs(): number`
  - `createNotifier(opts: { clock; queue: AlertQueue; bots: number; perBotPerSec: number; perChatPerSec: number; maxDigest: number; send(botId: number, chatId: string, alerts: Alert[]): Promise<{ ok: boolean; retryAfterSec?: number }>; onSent(alerts: Alert[], at: number): void }): { tick(): Promise<number>; run(): Promise<never>; held(): number }`

Queue order (LLD 6.8): oldest `postedAt` first while the oldest *queued* alert has waited less than `freshAfterMs`; freshest first otherwise. Alerts whose load was posted more than `deadlineMs` ago are dropped and counted.

- [ ] **Step 1: Write the failing test**

`src/alerts/alerts.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from '../shared/clock.ts';
import { createAlertQueue } from './alert-queue.ts';
import { createNotifier } from './notifier.ts';
import type { Alert } from '../shared/types.ts';

const alert = (userId: string, canonicalId: string, postedAt: number, enqueuedAt: number): Alert =>
  ({ userId, canonicalId, loadKey: `dat:${canonicalId}`, searchIds: ['S'], summary: canonicalId, postedAt, enqueuedAt });

test('one alert per user per load', () => {
  const clock = createFakeClock(1_000_000);
  const q = createAlertQueue({ clock, freshAfterMs: 10_000, deadlineMs: 600_000, ttlMs: 3_600_000 });
  assert.ok(q.offer(alert('U1', 'C1', 999_000, 1_000_000)));
  assert.equal(q.offer(alert('U1', 'C1', 999_000, 1_000_000)), false);
  assert.ok(q.offer(alert('U2', 'C1', 999_000, 1_000_000)));
  assert.equal(q.size(), 2);
});

test('oldest first while keeping up, freshest first when backed up, stale dropped', () => {
  const clock = createFakeClock(1_000_000);
  const q = createAlertQueue({ clock, freshAfterMs: 10_000, deadlineMs: 600_000, ttlMs: 3_600_000 });
  q.offer(alert('U1', 'A', 990_000, 1_000_000));
  q.offer(alert('U1', 'B', 995_000, 1_000_000));
  q.offer(alert('U1', 'OLD', 300_000, 1_000_000));     // posted 700 s ago: past the deadline
  let r = q.take(1);
  assert.equal(r.mode, 'oldest');
  assert.equal(r.alerts[0].canonicalId, 'A');
  assert.equal(q.dropped(), 1);
  clock.advance(20_000);                                // B now waited 20 s in the queue
  q.offer(alert('U1', 'C', 1_015_000, 1_020_000));
  r = q.take(1);
  assert.equal(r.mode, 'freshest');
  assert.equal(r.alerts[0].canonicalId, 'C');
});

test('notifier respects per-chat limit and merges a digest', async () => {
  const clock = createFakeClock(1_000_000);
  const q = createAlertQueue({ clock, freshAfterMs: 10_000, deadlineMs: 600_000, ttlMs: 3_600_000 });
  const sent: { chat: string; n: number }[] = [];
  const n = createNotifier({ clock, queue: q, bots: 1, perBotPerSec: 30, perChatPerSec: 1, maxDigest: 5,
    send: async (_bot, chat, alerts) => { sent.push({ chat, n: alerts.length }); return { ok: true }; }, onSent: () => {} });
  for (let i = 0; i < 7; i++) q.offer(alert('U1', `C${i}`, 999_000, 1_000_000));
  await n.tick();
  assert.deepEqual(sent, [{ chat: 'U1', n: 5 }]);   // one message, 5 loads
  await n.tick();
  assert.equal(sent.length, 1);                      // chat bucket empty: nothing more this second
  clock.advance(1_000);
  await n.tick();
  assert.deepEqual(sent[1], { chat: 'U1', n: 2 });
  assert.equal(n.held(), 0);
});

test('notifier backs off a bot on 429 and keeps the alerts', async () => {
  const clock = createFakeClock(1_000_000);
  const q = createAlertQueue({ clock, freshAfterMs: 10_000, deadlineMs: 600_000, ttlMs: 3_600_000 });
  let calls = 0;
  const n = createNotifier({ clock, queue: q, bots: 1, perBotPerSec: 30, perChatPerSec: 1, maxDigest: 5,
    send: async () => { calls++; return calls === 1 ? { ok: false, retryAfterSec: 3 } : { ok: true }; }, onSent: () => {} });
  q.offer(alert('U1', 'C1', 999_000, 1_000_000));
  await n.tick();
  assert.equal(n.held(), 1);
  clock.advance(1_000);
  await n.tick();
  assert.equal(calls, 1);                            // bot paused for 3 s
  clock.advance(3_000);
  await n.tick();
  assert.equal(calls, 2);
  assert.equal(n.held(), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/alerts/alerts.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/alerts/alert-queue.ts`:

```ts
import type { Clock } from '../shared/clock.ts';
import { createExpiringSet } from '../shared/expiring.ts';
import type { Alert } from '../shared/types.ts';

export interface AlertQueue {
  offer(a: Alert): boolean;
  take(max: number): { alerts: Alert[]; mode: 'oldest' | 'freshest' };
  size(): number;
  dropped(): number;
  oldestWaitMs(): number;
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
  };
}
```

`src/alerts/notifier.ts`:

```ts
import type { Clock } from '../shared/clock.ts';
import { createTokenBucket, type TokenBucket } from '../shared/bucket.ts';
import type { Alert } from '../shared/types.ts';
import type { AlertQueue } from './alert-queue.ts';

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

// Sends alerts within Telegram's limits (LLD 6.9): per bot and per chat token buckets; a chat with several
// waiting alerts gets them merged into one digest message.
export function createNotifier(opts: {
  clock: Clock; queue: AlertQueue; bots: number; perBotPerSec: number; perChatPerSec: number; maxDigest: number;
  send(botId: number, chatId: string, alerts: Alert[]): Promise<{ ok: boolean; retryAfterSec?: number }>;
  onSent(alerts: Alert[], at: number): void;
}) {
  const botBuckets: TokenBucket[] = Array.from({ length: opts.bots }, () => createTokenBucket(opts.perBotPerSec * 60, opts.perBotPerSec, opts.clock));
  const botPausedUntil: number[] = Array(opts.bots).fill(0);
  const chatBuckets = new Map<string, TokenBucket>();
  const held = new Map<string, Alert[]>();
  const chatBucket = (chat: string) => {
    let b = chatBuckets.get(chat);
    if (!b) { b = createTokenBucket(opts.perChatPerSec * 60, 1, opts.clock); chatBuckets.set(chat, b); }
    return b;
  };
  const heldCount = () => { let n = 0; for (const l of held.values()) n += l.length; return n; };

  async function tick(): Promise<number> {
    for (const a of opts.queue.take(1000).alerts) {
      const l = held.get(a.userId);
      if (l) l.push(a); else held.set(a.userId, [a]);
    }
    const now = opts.clock.now();
    const sends: Promise<void>[] = [];
    for (const [chat, list] of held) {
      const bot = hash(chat) % opts.bots;
      if (botPausedUntil[bot] > now) continue;
      const cb = chatBucket(chat);
      if (cb.nextTokenAt() > now || botBuckets[bot].nextTokenAt() > now) continue;
      cb.take(); botBuckets[bot].take();
      const batch = list.splice(0, opts.maxDigest);
      if (!list.length) held.delete(chat);
      sends.push(opts.send(bot, chat, batch).then((r) => {
        if (r.ok) { opts.onSent(batch, opts.clock.now()); return; }
        botPausedUntil[bot] = opts.clock.now() + (r.retryAfterSec ?? 1) * 1000;
        const back = held.get(chat);
        if (back) back.unshift(...batch); else held.set(chat, batch);
      }));
    }
    await Promise.all(sends);
    return sends.length;
  }

  return {
    tick,
    held: heldCount,
    async run(): Promise<never> {
      for (;;) { await tick(); await opts.clock.sleep(Math.max(50, 5 * opts.clock.speed)); }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/alerts/alerts.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/alerts
git commit -m "feat(alerts): alert queue with fresh-first overload mode and rate-limited notifier"
```

---

### Task 6: Planner (query merging, heat, square-root budget allocation)

**Files:**
- Create: `src/plan/heat.ts`, `src/plan/planner.ts`
- Test: `src/plan/plan.test.ts`

**Interfaces:**
- Consumes: `User`, `SearchSpec`, `PlanEntry`, `Equip`, `Clock`, `coverCells`, `milesBetween`
- Produces:
  - `createHeat(clock: Clock, alpha?: number, prior?: number): { record(cell3: string, equip: Equip): void; get(cell3: string, equip: Equip): number }`
  - `buildPlan(user: User, heatOf: (cell3: string, equip: Equip) => number): PlanEntry[]` (one set of merged queries, repeated for each of the user's credentials; `intervalMs` 60000 and `cursor` 0 until allocated)
  - `allocate(entries: PlanEntry[], budgetPerMin: number, minPerMin?: number, maxPerMin?: number): PlanEntry[]`
  - `MAX_MERGED_RADIUS_MI = 150`

- [ ] **Step 1: Write the failing test**

`src/plan/plan.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from '../shared/clock.ts';
import { createHeat } from './heat.ts';
import { buildPlan, allocate } from './planner.ts';
import type { PlanEntry, SearchSpec, User } from '../shared/types.ts';

const s = (id: string, lat: number, lon: number, deadheadMi: number, equipment: SearchSpec['equipment'] = 'van'): SearchSpec =>
  ({ searchId: id, userId: 'U1', lat, lon, deadheadMi, dest: { kind: 'anywhere' }, equipment, minRpm: null, includeNoRate: true, pickupWithinDays: 2 });

test('nearby searches with the same equipment merge into one query per credential', () => {
  const user: User = { userId: 'U1', credentials: [{ credentialId: 'dat-1', userId: 'U1', board: 'dat' }, { credentialId: 'ts-1', userId: 'U1', board: 'truckstop' }],
    searches: [s('A', 41.88, -87.63, 75), s('B', 41.53, -88.08, 50), s('C', 33.75, -84.39, 50), s('D', 41.88, -87.63, 75, 'reefer')] };
  const plan = buildPlan(user, () => 1);
  const dat = plan.filter((e) => e.credentialId === 'dat-1');
  assert.equal(dat.length, 3);                               // Chicago vans (A+B), Atlanta vans (C), Chicago reefer (D)
  const chicagoVans = dat.find((e) => e.searchIds.includes('A'))!;
  assert.deepEqual(chicagoVans.searchIds.sort(), ['A', 'B']);
  assert.ok(chicagoVans.query.radiusMi >= 75 && chicagoVans.query.radiusMi <= 150);
  assert.equal(plan.length, 6);                              // same 3 queries for the truckstop login
});

test('square-root allocation: frequencies sum to the budget and follow sqrt(heat)', () => {
  const e = (heat: number): PlanEntry => ({ entryId: String(heat), credentialId: 'c', userId: 'U', board: 'dat', query: { lat: 0, lon: 0, radiusMi: 50, equipment: ['van'] }, searchIds: [], heat, intervalMs: 60_000, cursor: 0 });
  const out = allocate([e(1), e(4), e(16)], 7);              // sqrt: 1, 2, 4 -> 1, 2, 4 polls per minute
  const perMin = out.map((x) => 60_000 / x.intervalMs);
  assert.deepEqual(perMin.map((x) => Math.round(x * 100) / 100), [1, 2, 4]);
  const clamped = allocate([e(0.0001), e(10_000)], 100);
  assert.ok(60_000 / clamped[1].intervalMs <= 12.0001);     // at most every 5 s
  assert.ok(60_000 / clamped[0].intervalMs >= 0.1999);      // at least every 5 min
});

test('heat is an EWMA of postings per minute', () => {
  const clock = createFakeClock(0);
  const heat = createHeat(clock, 0.5, 0);
  for (let i = 0; i < 10; i++) heat.record('dp3', 'van');
  clock.advance(60_000);
  assert.equal(heat.get('dp3', 'van'), 5);                   // 0.5 * 10
  clock.advance(60_000);
  assert.equal(heat.get('dp3', 'van'), 2.5);
  assert.equal(heat.get('zzz', 'van'), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/plan/plan.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/plan/heat.ts`:

```ts
import type { Clock } from '../shared/clock.ts';
import type { Equip } from '../shared/types.ts';

// New postings per simulated minute per (level-3 cell, equipment), as an EWMA (LLD 6.2).
export function createHeat(clock: Clock, alpha = 0.1, prior = 0.05) {
  const m = new Map<string, { ewma: number; minute: number; count: number }>();
  const roll = (s: { ewma: number; minute: number; count: number }, minute: number) => {
    const gap = minute - s.minute;
    if (gap <= 0) return;
    const first = alpha * s.count + (1 - alpha) * s.ewma;
    s.ewma = first * (1 - alpha) ** (gap - 1);
    s.count = 0;
    s.minute = minute;
  };
  return {
    record(cell3: string, equip: Equip) {
      const k = `${cell3}|${equip}`;
      const minute = Math.floor(clock.now() / 60_000);
      let s = m.get(k);
      if (!s) { s = { ewma: prior, minute, count: 0 }; m.set(k, s); }
      roll(s, minute);
      s.count++;
    },
    get(cell3: string, equip: Equip): number {
      const s = m.get(`${cell3}|${equip}`);
      if (!s) return prior;
      roll(s, Math.floor(clock.now() / 60_000));
      return s.ewma;
    },
  };
}
```

`src/plan/planner.ts`:

```ts
import { coverCells, milesBetween } from '../shared/geo.ts';
import type { Equip, PlanEntry, SearchSpec, User } from '../shared/types.ts';

export const MAX_MERGED_RADIUS_MI = 150;

// Merge one user's searches into the fewest board queries (LLD 6.2); the matcher filters exactly afterwards.
export function buildPlan(user: User, heatOf: (cell3: string, equip: Equip) => number): PlanEntry[] {
  const byEquip = new Map<Equip, SearchSpec[]>();
  for (const s of user.searches) {
    const l = byEquip.get(s.equipment);
    if (l) l.push(s); else byEquip.set(s.equipment, [s]);
  }
  const clusters: { equip: Equip; lat: number; lon: number; radius: number; ids: string[] }[] = [];
  for (const [equip, specs] of byEquip) {
    const own: typeof clusters = [];
    for (const s of [...specs].sort((x, y) => y.deadheadMi - x.deadheadMi)) {
      const c = own.find((k) => milesBetween(k.lat, k.lon, s.lat, s.lon) + s.deadheadMi <= MAX_MERGED_RADIUS_MI);
      if (c) { c.radius = Math.max(c.radius, milesBetween(c.lat, c.lon, s.lat, s.lon) + s.deadheadMi); c.ids.push(s.searchId); }
      else own.push({ equip, lat: s.lat, lon: s.lon, radius: s.deadheadMi, ids: [s.searchId] });
    }
    clusters.push(...own);
  }
  const out: PlanEntry[] = [];
  for (const cred of user.credentials) {
    clusters.forEach((c, i) => {
      const heat = Math.max(0.01, coverCells(c.lat, c.lon, c.radius, 3).reduce((sum, cell) => sum + heatOf(cell, c.equip), 0));
      out.push({ entryId: `${cred.credentialId}:${i}`, credentialId: cred.credentialId, userId: user.userId, board: cred.board,
        query: { lat: c.lat, lon: c.lon, radiusMi: Math.ceil(c.radius), equipment: [c.equip] }, searchIds: [...c.ids], heat, intervalMs: 60_000, cursor: 0 });
    });
  }
  return out;
}

// Square-root rule (LLD 6.3): f_i = B * sqrt(heat_i) / sum sqrt(heat_j), clamped to [every 5 min, every 5 s].
export function allocate(entries: PlanEntry[], budgetPerMin: number, minPerMin = 0.2, maxPerMin = 12): PlanEntry[] {
  const total = entries.reduce((s, e) => s + Math.sqrt(e.heat), 0) || 1;
  return entries.map((e) => {
    const f = Math.min(maxPerMin, Math.max(minPerMin, (budgetPerMin * Math.sqrt(e.heat)) / total));
    return { ...e, intervalMs: 60_000 / f };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/plan/plan.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/plan
git commit -m "feat(plan): query merging, heat EWMA, square-root budget allocation"
```

---

### Task 7: Scheduler (heap, per-login budget, backoff, circuit breaker, ban)

**Files:**
- Create: `src/schedule/scheduler.ts`
- Test: `src/schedule/scheduler.test.ts`

**Interfaces:**
- Consumes: `PlanEntry`, `Clock`, `createHeap`, `createTokenBucket`
- Produces: `createScheduler(opts: { clock: Clock; budgetPerMin: number; dispatch(e: PlanEntry): boolean; jitter?: () => number }): { setEntries(credentialId: string, entries: PlanEntry[]): void; report(credentialId: string, status: number, retryAfterSec?: number): void; tick(): number; run(): Promise<never>; stats(): SchedulerStats }`
- `SchedulerStats = { entries: number; credentials: number; paused: number; banned: number; pausedTotal: number; bannedTotal: number; stretch: number; dispatched: number; deferredByBudget: number }`

Backoff on 429 waits **at least** the board's `Retry-After` (LLD 6.3 said `min`; waiting less than Retry-After only causes more 429s, so this plan uses `max(Retry-After, 2^n × 5 s)`, capped at 15 min; Task 13 updates the LLD).

- [ ] **Step 1: Write the failing test**

`src/schedule/scheduler.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from '../shared/clock.ts';
import { createScheduler } from './scheduler.ts';
import type { PlanEntry } from '../shared/types.ts';

const entry = (id: string, credentialId: string, intervalMs: number): PlanEntry =>
  ({ entryId: id, credentialId, userId: 'U', board: 'dat', query: { lat: 0, lon: 0, radiusMi: 50, equipment: ['van'] }, searchIds: [], heat: 1, intervalMs, cursor: 0 });

const drive = (clock: ReturnType<typeof createFakeClock>, s: ReturnType<typeof createScheduler>, ms: number, step = 100) => {
  for (let t = 0; t < ms; t += step) { s.tick(); clock.advance(step); }
};

test('polls each entry about once per interval', () => {
  const clock = createFakeClock(0);
  const polled: string[] = [];
  const s = createScheduler({ clock, budgetPerMin: 600, dispatch: (e) => { polled.push(e.entryId); return true; }, jitter: () => 1 });
  s.setEntries('c1', [entry('a', 'c1', 5_000), entry('b', 'c1', 20_000)]);
  drive(clock, s, 60_000);
  const a = polled.filter((x) => x === 'a').length, b = polled.filter((x) => x === 'b').length;
  assert.ok(a >= 11 && a <= 13, `a=${a}`);
  assert.ok(b >= 2 && b <= 4, `b=${b}`);
});

test('never exceeds the login budget', () => {
  const clock = createFakeClock(0);
  let n = 0;
  const s = createScheduler({ clock, budgetPerMin: 6, dispatch: () => { n++; return true; }, jitter: () => 1 });
  s.setEntries('c1', [entry('a', 'c1', 1_000), entry('b', 'c1', 1_000)]);
  drive(clock, s, 120_000);
  assert.ok(n <= 6 * 2 + 1, `n=${n}`);                      // 6 per minute for 2 minutes (+ initial burst of 1)
  assert.ok(s.stats().deferredByBudget > 0);
});

test('429 pauses the login for at least Retry-After; three 429s open the circuit; 403 bans', () => {
  const clock = createFakeClock(0);
  let n = 0;
  const s = createScheduler({ clock, budgetPerMin: 600, dispatch: () => { n++; return true; }, jitter: () => 1 });
  s.setEntries('c1', [entry('a', 'c1', 1_000)]);
  s.tick();
  s.report('c1', 429, 30);
  const before = n;
  drive(clock, s, 29_000);
  assert.equal(n, before);                                  // paused 30 s
  drive(clock, s, 2_000);
  assert.ok(n > before);
  s.report('c1', 429, 1); s.report('c1', 429, 1);
  assert.equal(s.stats().pausedTotal, 1);                   // circuit opened
  s.report('c1', 403);
  const atBan = n;
  drive(clock, s, 20 * 60_000, 1_000);
  assert.equal(n, atBan);
  assert.equal(s.stats().banned, 1);
});

test('replacing entries keeps the cursor of an entry with the same id', () => {
  const clock = createFakeClock(0);
  const seen: PlanEntry[] = [];
  const s = createScheduler({ clock, budgetPerMin: 600, dispatch: (e) => { seen.push(e); return true; }, jitter: () => 1 });
  const e1 = entry('a', 'c1', 1_000);
  s.setEntries('c1', [e1]);
  drive(clock, s, 2_000);
  e1.cursor = 12345;
  s.setEntries('c1', [entry('a', 'c1', 1_000)]);
  seen.length = 0;
  drive(clock, s, 2_000);
  assert.equal(seen[0].cursor, 12345);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/schedule/scheduler.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/schedule/scheduler.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/schedule/scheduler.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/schedule
git commit -m "feat(schedule): heap scheduler with per-login budgets, backoff, circuit breaker"
```

---

### Task 8: Board and Telegram simulators

**Files:**
- Create: `sims/cover.ts`, `sims/boards-sim.ts`, `sims/telegram-sim.ts`
- Test: `sims/sims.test.ts`

**Interfaces:**
- Consumes: `Clock`, `createSimClock`, `createTokenBucket`, `geohash`, `coverCells`, `milesBetween`, `rawId`
- Produces:
  - `coverTime(loadId: string, firstPostedAt: number, medianMin?: number): number`
  - `loadBoardData(postingsFile: string, truthFile: string): BoardData`
  - `createBoardsHandler(data: BoardData, opts: { clock: Clock; budgetPerMin: number; banAfterRejects: number; banWindowMs: number }): (req, res) => void`, plus `boardsStats()` on the returned function's `.stats` property
  - `createTelegramHandler(opts: { clock: Clock; perBotPerSec: number; perChatPerSec: number; onDelivered(d: Delivery): void })`
  - `Delivery = { botId: string; chatId: string; at: number; loads: { loadKey: string; canonicalId: string; postedAt: number }[] }`
  - Board HTTP contract: `GET /{board}/loads?lat&lon&radius&equipment&pickup_from&pickup_to&since` with header `x-credential` → `200 { now, items }` | `429` + `retry-after` | `403 { error: 'account_suspended' }`; `GET /stats`
  - Telegram HTTP contract: `POST /bot{id}/sendMessage { chat_id, text, meta: { loads } }` → `200 { ok: true }` | `429 { ok: false, parameters: { retry_after } }`; `GET /stats`
  - CLIs: `node sims/boards-sim.ts --data DIR --port N --sim-start ISO --real-start MS --speed X --budget N`; `node sims/telegram-sim.ts --port N --log FILE --sim-start ISO --real-start MS --speed X`

- [ ] **Step 1: Write the failing test**

`sims/sims.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createFakeClock } from '../src/shared/clock.ts';
import { coverTime } from './cover.ts';
import { loadBoardData, createBoardsHandler } from './boards-sim.ts';
import { createTelegramHandler, type Delivery } from './telegram-sim.ts';

const T0 = Date.parse('2026-11-04T15:00:00Z');
const listen = async (h: Parameters<typeof createServer>[1]) => {
  const s = createServer(h);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
};

function dataset() {
  const dir = mkdtempSync(join(tmpdir(), 'lr-sim-'));
  const truth = [
    { load_id: 'L1', origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63 }, dest: { city: 'Atlanta', state: 'GA', lat: 33.75, lon: -84.39 }, equipment: 'van', pickup_date: '2026-11-04', first_posted_at: new Date(T0).toISOString(), postings: [{ board: 'dat', board_load_id: 'DAT-1', posted_at: new Date(T0).toISOString() }] },
    { load_id: 'L2', origin: { city: 'Dallas', state: 'TX', lat: 32.78, lon: -96.8 }, dest: { city: 'Houston', state: 'TX', lat: 29.76, lon: -95.37 }, equipment: 'van', pickup_date: '2026-11-04', first_posted_at: new Date(T0).toISOString(), postings: [{ board: 'dat', board_load_id: 'DAT-2', posted_at: new Date(T0).toISOString() }] },
  ];
  writeFileSync(join(dir, 'truth.ndjson'), truth.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const postings = [
    { board: 'dat', posted_at: new Date(T0).toISOString(), raw: { id: 'DAT-1' } },
    { board: 'dat', posted_at: new Date(T0).toISOString(), raw: { id: 'DAT-2' } },
  ];
  writeFileSync(join(dir, 'postings.ndjson'), postings.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return dir;
}

test('coverTime is deterministic and around 20 minutes', () => {
  assert.equal(coverTime('L1', 0), coverTime('L1', 0));
  const mins = Array.from({ length: 500 }, (_, i) => coverTime(`L${i}`, 0) / 60_000).sort((a, b) => a - b);
  const median = mins[250];
  assert.ok(median > 15 && median < 27, `median ${median}`);
});

test('boards-sim returns only posted, open, nearby loads newer than since', async () => {
  const dir = dataset();
  const clock = createFakeClock(T0 - 1_000);
  const srv = await listen(createBoardsHandler(loadBoardData(join(dir, 'postings.ndjson'), join(dir, 'truth.ndjson')), { clock, budgetPerMin: 600, banAfterRejects: 20, banWindowMs: 600_000 }));
  const q = (since: number) => fetch(`${srv.url}/dat/loads?lat=41.88&lon=-87.63&radius=100&equipment=van&pickup_from=2026-11-04&pickup_to=2026-11-10&since=${since}`, { headers: { 'x-credential': 'c1' } }).then((r) => r.json());
  assert.deepEqual((await q(0)).items, []);                 // not posted yet
  clock.advance(2_000);
  const r1 = await q(0);
  assert.deepEqual(r1.items, [{ id: 'DAT-1' }]);           // Dallas load is too far away
  assert.deepEqual((await q(r1.now)).items, []);           // nothing newer than the cursor
  clock.advance(10 * 3_600_000);                          // cover times top out around 8 h
  assert.deepEqual((await q(0)).items, []);                // covered by now
  srv.close();
});

test('boards-sim answers 429 past the budget and 403 after repeated abuse', async () => {
  const dir = dataset();
  const clock = createFakeClock(T0);
  const srv = await listen(createBoardsHandler(loadBoardData(join(dir, 'postings.ndjson'), join(dir, 'truth.ndjson')), { clock, budgetPerMin: 6, banAfterRejects: 3, banWindowMs: 600_000 }));
  const get = () => fetch(`${srv.url}/dat/loads?lat=41.88&lon=-87.63&radius=50&equipment=van&pickup_from=2026-11-04&pickup_to=2026-11-10&since=0`, { headers: { 'x-credential': 'abuser' } });
  assert.equal((await get()).status, 200);                 // burst of 1
  const r = await get();
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  await get(); await get();
  assert.equal((await get()).status, 403);
  srv.close();
});

test('telegram-sim enforces per-chat limit and logs deliveries', async () => {
  const clock = createFakeClock(T0);
  const log: Delivery[] = [];
  const srv = await listen(createTelegramHandler({ clock, perBotPerSec: 30, perChatPerSec: 1, onDelivered: (d) => log.push(d) }));
  const send = () => fetch(`${srv.url}/bot0/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 'U1', text: 'x', meta: { loads: [{ loadKey: 'dat:1', canonicalId: 'C1', postedAt: T0 }] } }) });
  assert.equal((await send()).status, 200);
  const r = await send();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).parameters.retry_after, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].chatId, 'U1');
  assert.equal(log[0].at, T0);
  srv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test sims/sims.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`sims/cover.ts`:

```ts
// When a load gets taken ("covered"): deterministic per load id, lognormal around `medianMin` minutes.
export function coverTime(loadId: string, firstPostedAt: number, medianMin = 20): number {
  let h = 2166136261;
  for (let i = 0; i < loadId.length; i++) { h ^= loadId.charCodeAt(i); h = Math.imul(h, 16777619); }
  const u1 = (((h >>> 0) % 1_000_000) + 0.5) / 1_000_000;
  h = Math.imul(h ^ (h >>> 13), 16777619);
  const u2 = (((h >>> 0) % 1_000_000) + 0.5) / 1_000_000;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return firstPostedAt + medianMin * 60_000 * Math.exp(0.6 * z);
}
```

`sims/boards-sim.ts`:

```ts
// Simulated load boards (LLD 5.2): replays sim/gen.ts postings on the simulated clock, enforces per-login budgets.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSimClock, type Clock } from '../src/shared/clock.ts';
import { createTokenBucket, type TokenBucket } from '../src/shared/bucket.ts';
import { coverCells, geohash, milesBetween } from '../src/shared/geo.ts';
import { rawId } from '../src/normalize/normalize.ts';
import type { Board } from '../src/shared/types.ts';
import { coverTime } from './cover.ts';

export type SimItem = { postedAt: number; coveredAt: number; lat: number; lon: number; equip: string; pickup: string; raw: unknown };
export type BoardData = Map<string, Map<string, SimItem[]>>;   // board -> level-3 cell -> items by postedAt

const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

export function loadBoardData(postingsFile: string, truthFile: string): BoardData {
  const info = new Map<string, Omit<SimItem, 'postedAt' | 'raw'>>();
  for (const line of lines(truthFile)) {
    const l = JSON.parse(line);
    const coveredAt = coverTime(l.load_id, Date.parse(l.first_posted_at));
    for (const p of l.postings) info.set(`${p.board}:${p.board_load_id}`, { coveredAt, lat: l.origin.lat, lon: l.origin.lon, equip: l.equipment, pickup: l.pickup_date });
  }
  const data: BoardData = new Map();
  for (const line of lines(postingsFile)) {
    const p = JSON.parse(line);
    const i = info.get(`${p.board}:${rawId(p.board as Board, p.raw)}`);
    if (!i) continue;
    const cell = geohash(i.lat, i.lon, 3);
    if (!data.has(p.board)) data.set(p.board, new Map());
    const byCell = data.get(p.board)!;
    if (!byCell.has(cell)) byCell.set(cell, []);
    byCell.get(cell)!.push({ ...i, postedAt: Date.parse(p.posted_at), raw: p.raw });
  }
  for (const byCell of data.values()) for (const list of byCell.values()) list.sort((a, b) => a.postedAt - b.postedAt);
  return data;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const firstAfter = (list: SimItem[], since: number) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].postedAt <= since) lo = m + 1; else hi = m; } return lo; };

export function createBoardsHandler(data: BoardData, opts: { clock: Clock; budgetPerMin: number; banAfterRejects: number; banWindowMs: number }) {
  const creds = new Map<string, { bucket: TokenBucket; rejects: number[]; banned: boolean }>();
  const stats = { ok: 0, rejected: 0, bannedRequests: 0, bannedLogins: 0 };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://sim');
    if (url.pathname === '/stats') { json(res, 200, stats); return; }
    const m = /^\/(dat|truckstop|portal_a|portal_b)\/loads$/.exec(url.pathname);
    if (!m) { json(res, 404, { error: 'not_found' }); return; }
    const now = opts.clock.now();
    const credId = String(req.headers['x-credential'] ?? '');
    let c = creds.get(credId);
    if (!c) { c = { bucket: createTokenBucket(opts.budgetPerMin, Math.max(1, opts.budgetPerMin / 6), opts.clock), rejects: [], banned: false }; creds.set(credId, c); }
    if (c.banned) { stats.bannedRequests++; json(res, 403, { error: 'account_suspended' }); return; }
    if (!c.bucket.take()) {
      c.rejects = c.rejects.filter((t) => now - t < opts.banWindowMs);
      c.rejects.push(now);
      stats.rejected++;
      if (c.rejects.length > opts.banAfterRejects) { c.banned = true; stats.bannedLogins++; json(res, 403, { error: 'account_suspended' }); return; }
      json(res, 429, { error: 'rate_limited' }, { 'retry-after': String(Math.max(1, Math.ceil((c.bucket.nextTokenAt() - now) / 1000))) });
      return;
    }
    const p = url.searchParams;
    const lat = Number(p.get('lat')), lon = Number(p.get('lon')), radius = Number(p.get('radius')), since = Number(p.get('since') ?? 0);
    const equip = new Set((p.get('equipment') ?? '').split(','));
    const from = p.get('pickup_from') ?? '0000-00-00', to = p.get('pickup_to') ?? '9999-99-99';
    const items: unknown[] = [];
    const byCell = data.get(m[1]);
    for (const cell of byCell ? coverCells(lat, lon, radius, 3) : []) {
      const list = byCell!.get(cell);
      if (!list) continue;
      for (let i = firstAfter(list, since); i < list.length && list[i].postedAt <= now && items.length < 500; i++) {
        const it = list[i];
        if (it.coveredAt <= now || !equip.has(it.equip) || it.pickup < from || it.pickup > to) continue;
        if (milesBetween(lat, lon, it.lat, it.lon) > radius) continue;
        items.push(it.raw);
      }
    }
    stats.ok++;
    json(res, 200, { now, items });
  };
  return Object.assign(handler, { stats });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { data: { type: 'string', default: 'out' }, port: { type: 'string', default: '7001' }, 'sim-start': { type: 'string' }, 'real-start': { type: 'string' }, speed: { type: 'string', default: '1' }, budget: { type: 'string', default: '60' } } });
  const clock = createSimClock({ simStart: Date.parse(a['sim-start']!), realStart: Number(a['real-start']), speed: Number(a.speed) });
  const data = loadBoardData(join(a.data!, 'postings.ndjson'), join(a.data!, 'truth.ndjson'));
  const h = createBoardsHandler(data, { clock, budgetPerMin: Number(a.budget), banAfterRejects: 20, banWindowMs: 10 * 60_000 });
  createServer(h).listen(Number(a.port), '127.0.0.1', () => console.log(`boards-sim on :${a.port}`));
}
```

`sims/telegram-sim.ts`:

```ts
// Simulated Telegram Bot API (LLD 5.3): ~30 msg/s per bot, ~1 msg/s per chat, on the simulated clock.
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSimClock, type Clock } from '../src/shared/clock.ts';
import { createTokenBucket, type TokenBucket } from '../src/shared/bucket.ts';

export type Delivery = { botId: string; chatId: string; at: number; loads: { loadKey: string; canonicalId: string; postedAt: number }[] };

export function createTelegramHandler(opts: { clock: Clock; perBotPerSec: number; perChatPerSec: number; onDelivered(d: Delivery): void }) {
  const bots = new Map<string, TokenBucket>();
  const chats = new Map<string, TokenBucket>();
  const stats = { delivered: 0, limited: 0 };
  const bucket = (m: Map<string, TokenBucket>, k: string, perSec: number, burst: number) => {
    let b = m.get(k);
    if (!b) { b = createTokenBucket(perSec * 60, burst, opts.clock); m.set(k, b); }
    return b;
  };
  const reply = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  return Object.assign((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/stats') { reply(res, 200, stats); return; }
    const m = /^\/bot([^/]+)\/sendMessage$/.exec(req.url ?? '');
    if (!m || req.method !== 'POST') { reply(res, 404, { ok: false }); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const now = opts.clock.now();
      const bot = bucket(bots, m[1], opts.perBotPerSec, opts.perBotPerSec);
      const chat = bucket(chats, String(body.chat_id), opts.perChatPerSec, 1);
      if (bot.nextTokenAt() > now || chat.nextTokenAt() > now) {
        stats.limited++;
        const wait = Math.max(bot.nextTokenAt(), chat.nextTokenAt()) - now;
        reply(res, 429, { ok: false, error_code: 429, parameters: { retry_after: Math.max(1, Math.ceil(wait / 1000)) } });
        return;
      }
      bot.take(); chat.take();
      stats.delivered++;
      opts.onDelivered({ botId: m[1], chatId: String(body.chat_id), at: now, loads: body.meta?.loads ?? [] });
      reply(res, 200, { ok: true });
    });
  }, { stats });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { port: { type: 'string', default: '7002' }, log: { type: 'string', default: 'deliveries.ndjson' }, 'sim-start': { type: 'string' }, 'real-start': { type: 'string' }, speed: { type: 'string', default: '1' } } });
  const clock = createSimClock({ simStart: Date.parse(a['sim-start']!), realStart: Number(a['real-start']), speed: Number(a.speed) });
  const h = createTelegramHandler({ clock, perBotPerSec: 30, perChatPerSec: 1, onDelivered: (d) => appendFileSync(a.log!, JSON.stringify(d) + '\n') });
  createServer(h).listen(Number(a.port), '127.0.0.1', () => console.log(`telegram-sim on :${a.port}`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test sims/sims.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add sims
git commit -m "feat(sims): board simulator with budgets and bans, Telegram simulator"
```

---

### Task 9: Poller (undici pools sized by Little's law, pool-wait measurement)

**Files:**
- Create: `src/poll/poller.ts`
- Test: `src/poll/poller.test.ts`

**Interfaces:**
- Consumes: `PlanEntry`, `Clock`, `createSemaphore`, `centralDate`, boards-sim HTTP contract (Task 8)
- Produces:
  - `PollResult = { status: number; retryAfterSec?: number; items: unknown[]; requestMs: number; poolWaitMs: number }` (`status` 0 = network error or timeout)
  - `createPoller(opts: { baseUrl: string; connectionsPerBoard: number; clock: Clock; timeoutMs: number; onResponse(e: PlanEntry, r: PollResult): void }): { poll(e: PlanEntry): Promise<void>; inFlight(): number; close(): Promise<void> }`
  - On 200, sets `e.cursor = body.now`.

- [ ] **Step 1: Write the failing test**

`src/poll/poller.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFakeClock } from '../shared/clock.ts';
import { createPoller, type PollResult } from './poller.ts';
import type { PlanEntry } from '../shared/types.ts';

const entry = (): PlanEntry => ({ entryId: 'e1', credentialId: 'c1', userId: 'U1', board: 'dat', query: { lat: 41.88, lon: -87.63, radiusMi: 75, equipment: ['van'] }, searchIds: ['S1'], heat: 1, intervalMs: 5_000, cursor: 0 });

test('poller sends the query and credential, moves the cursor, reports results', async () => {
  const seen: { url: string; cred: string }[] = [];
  let status = 200;
  const srv = createServer((req, res) => {
    seen.push({ url: req.url!, cred: String(req.headers['x-credential']) });
    if (status === 429) { res.writeHead(429, { 'retry-after': '7' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ now: 1234, items: [{ id: 'DAT-1' }] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const results: PollResult[] = [];
  const poller = createPoller({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, connectionsPerBoard: 2, clock: createFakeClock(Date.parse('2026-11-04T15:00:00Z')), timeoutMs: 2_000, onResponse: (_e, r) => results.push(r) });
  const e = entry();
  await poller.poll(e);
  assert.equal(seen[0].cred, 'c1');
  assert.match(seen[0].url, /^\/dat\/loads\?lat=41.88&lon=-87.63&radius=75&equipment=van&pickup_from=2026-11-04&pickup_to=2026-11-11&since=0$/);
  assert.equal(results[0].status, 200);
  assert.deepEqual(results[0].items, [{ id: 'DAT-1' }]);
  assert.equal(e.cursor, 1234);
  status = 429;
  await poller.poll(e);
  assert.equal(results[1].status, 429);
  assert.equal(results[1].retryAfterSec, 7);
  assert.equal(e.cursor, 1234);
  await poller.close();
  srv.close();
});

test('requests beyond the pool size wait, and the wait is measured', async () => {
  const srv = createServer((_req, res) => { setTimeout(() => { res.writeHead(200); res.end('{"now":1,"items":[]}'); }, 100); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const results: PollResult[] = [];
  const poller = createPoller({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, connectionsPerBoard: 1, clock: createFakeClock(0), timeoutMs: 2_000, onResponse: (_e, r) => results.push(r) });
  await Promise.all([poller.poll(entry()), poller.poll(entry())]);
  const waits = results.map((r) => r.poolWaitMs).sort((a, b) => a - b);
  assert.ok(waits[0] < 20, `first ${waits[0]}`);
  assert.ok(waits[1] >= 80, `second ${waits[1]}`);
  await poller.close();
  srv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/poll/poller.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/poll/poller.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/poll/poller.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/poll
git commit -m "feat(poll): per-board HTTP pools with measured pool wait"
```

---

### Task 10: Observability module and local stack

**Files:**
- Create: `src/obs/obs.ts`, `docker-compose.yml`, `ops/otel-collector.yaml`, `ops/prometheus.yml`, `ops/grafana/datasources.yaml`
- Test: `src/obs/obs.test.ts`

**Interfaces:**
- Consumes: prom-client, OpenTelemetry SDK
- Produces: `setupObs(opts: { sampleRate: number; otlpEndpoint: string | null; metricsPort: number | null; timeEvery?: number })` returning:
  - `begin(): PostingTrace`, `stage<R>(name: Stage, t: PostingTrace, fn: () => R): R`, `finish(t: PostingTrace, attrs: Record<string, string | number>): void`
  - `dedup(result: string)`, `fanout(n: number)`, `normalizeFailed(board: string, reason: string)`, `upstream(board: string, status: number, requestMs: number, poolWaitMs: number)`, `postToAlert(seconds: number)`, `queueWait(queue: string, waitsMs: number[])`, `overflow(queue: string)`, `gauges(values: Record<string, number>)`, `flush()`, `metricsText(): Promise<string>`, `spansDropped(): number`, `close(): Promise<void>`
  - Metric names: `stage_duration_seconds{stage}`, `stage_items_total{stage}`, `dedup_total{result}`, `match_fanout`, `normalize_failed_total{board,reason}`, `upstream_requests_total{board,status}`, `upstream_request_seconds{board}`, `http_pool_wait_seconds{board}`, `post_to_alert_seconds`, `stage_queue_wait_seconds{queue}`, `queue_overflow_total{queue}`, `engine_gauge{name}`, `spans_dropped_total`

The measured configuration (RESULTS.md): counters as plain numbers flushed per batch; stage timings for 1 in `timeEvery` (16) postings; sampling decided here before touching the SDK; one span per posting, created at `finish` with stage timings as attributes; failed postings always get a span.

- [ ] **Step 1: Write the failing test**

`src/obs/obs.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupObs } from './obs.ts';

test('lite counters reach prom-client after flush; timings are sampled', async () => {
  const obs = setupObs({ sampleRate: 0, otlpEndpoint: null, metricsPort: null, timeEvery: 4 });
  for (let i = 0; i < 8; i++) { const t = obs.begin(); obs.stage('normalize', t, () => 1); obs.finish(t, { board: 'dat' }); }
  obs.dedup('new');
  let text = await obs.metricsText();
  assert.doesNotMatch(text, /stage_items_total\{stage="normalize"\} \d/);   // nothing reaches prom-client until flush
  obs.flush();
  text = await obs.metricsText();
  assert.match(text, /stage_items_total\{stage="normalize"\} 8/);
  assert.match(text, /dedup_total\{result="new"\} 1/);
  assert.match(text, /stage_duration_seconds_count\{stage="normalize"\} 2/);   // 1 in 4 timed
  await obs.close();
});

test('sampled postings and failures become one span each', async () => {
  let spans = 0;
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const j = JSON.parse(Buffer.concat(chunks).toString());
      for (const rs of j.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) spans += ss.spans.length;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const obs = setupObs({ sampleRate: 1, otlpEndpoint: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/traces`, metricsPort: null });
  for (let i = 0; i < 3; i++) { const t = obs.begin(); obs.stage('normalize', t, () => 1); obs.stage('dedup', t, () => 1); obs.finish(t, { board: 'dat' }); }
  await obs.close();
  srv.close();
  assert.equal(spans, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/obs/obs.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/obs/obs.ts`:

```ts
import { createServer, type Server } from 'node:http';
import client from 'prom-client';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

export const STAGES = ['normalize', 'dedup', 'match', 'alert'] as const;
export type Stage = (typeof STAGES)[number];
export type PostingTrace = { sampled: boolean; timed: boolean; startWall: number; startPerf: number; stageMs: Record<string, number> };

// The measured configuration from bench/overhead/RESULTS.md (+1.0% CPU).
export function setupObs(opts: { sampleRate: number; otlpEndpoint: string | null; metricsPort: number | null; timeEvery?: number }) {
  const timeEvery = opts.timeEvery ?? 16;
  const reg = new client.Registry();
  client.collectDefaultMetrics({ register: reg });
  const dur = new client.Histogram({ name: 'stage_duration_seconds', help: 'time per posting per stage (1 in N postings)', labelNames: ['stage'], registers: [reg], buckets: [0.000005, 0.00001, 0.000025, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.01] });
  const items = new client.Counter({ name: 'stage_items_total', help: 'postings processed per stage', labelNames: ['stage'], registers: [reg] });
  const dedupC = new client.Counter({ name: 'dedup_total', help: 'dedup results', labelNames: ['result'], registers: [reg] });
  const fanoutH = new client.Histogram({ name: 'match_fanout', help: 'candidate searches per new load (1 in N)', registers: [reg], buckets: [1, 10, 100, 1000, 10000] });
  const normFail = new client.Counter({ name: 'normalize_failed_total', help: 'postings dropped by the normalizer', labelNames: ['board', 'reason'], registers: [reg] });
  const upReq = new client.Counter({ name: 'upstream_requests_total', help: 'board requests by status', labelNames: ['board', 'status'], registers: [reg] });
  const upSec = new client.Histogram({ name: 'upstream_request_seconds', help: 'board response time, excluding pool wait', labelNames: ['board'], registers: [reg], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] });
  const poolWait = new client.Histogram({ name: 'http_pool_wait_seconds', help: 'time waiting for a free socket', labelNames: ['board'], registers: [reg], buckets: [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5] });
  const p2a = new client.Histogram({ name: 'post_to_alert_seconds', help: 'board posted_at to Telegram accepted (simulated seconds)', registers: [reg], buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300, 600] });
  const qWait = new client.Histogram({ name: 'stage_queue_wait_seconds', help: 'time in a stage queue (1 in N)', labelNames: ['queue'], registers: [reg], buckets: [0.0001, 0.001, 0.01, 0.1, 1, 10] });
  const overflowC = new client.Counter({ name: 'queue_overflow_total', help: 'items refused by a full queue', labelNames: ['queue'], registers: [reg] });
  const gauge = new client.Gauge({ name: 'engine_gauge', help: 'engine state (queue depths, logins paused or banned, ...)', labelNames: ['name'], registers: [reg] });
  const dropped = new client.Counter({ name: 'spans_dropped_total', help: 'spans dropped by the exporter queue', registers: [reg] });
  const durBy = Object.fromEntries(STAGES.map((s) => [s, dur.labels(s)]));
  const itemsBy = Object.fromEntries(STAGES.map((s) => [s, items.labels(s)]));

  let droppedSpans = 0;
  let provider: BasicTracerProvider | null = null;
  if (opts.otlpEndpoint) {
    diag.setLogger({ warn: (m: string) => { const x = /Dropped (\d+) spans/.exec(m); if (x) { droppedSpans += Number(x[1]); dropped.inc(Number(x[1])); } }, error: () => {}, info: () => {}, debug: () => {}, verbose: () => {} }, DiagLogLevel.WARN);
    provider = new BasicTracerProvider({ resource: resourceFromAttributes({ 'service.name': 'load-radar-engine' }), sampler: new AlwaysOnSampler(),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.otlpEndpoint }), { maxQueueSize: 8192 })] });
  }
  const tracer = provider?.getTracer('load-radar');

  const localItems: Record<string, number> = { normalize: 0, dedup: 0, match: 0, alert: 0 };
  const localDedup: Record<string, number> = {};
  let seq = 0, fanSeq = 0, waitSeq = 0;
  let server: Server | null = null;
  if (opts.metricsPort) {
    server = createServer(async (req, res) => {
      if (req.url !== '/metrics') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': reg.contentType });
      res.end(await reg.metrics());
    }).listen(opts.metricsPort, '0.0.0.0');
  }

  return {
    begin(): PostingTrace {
      const sampled = tracer !== undefined && Math.random() < opts.sampleRate;   // decided here: unsampled postings never touch the SDK
      return { sampled, timed: sampled || seq++ % timeEvery === 0, startWall: Date.now(), startPerf: performance.now(), stageMs: {} };
    },
    stage<R>(name: Stage, t: PostingTrace, fn: () => R): R {
      localItems[name]++;
      if (!t.timed) return fn();
      const s = performance.now();
      try { return fn(); } finally { const ms = performance.now() - s; durBy[name].observe(ms / 1000); t.stageMs[`${name}_ms`] = ms; }
    },
    finish(t: PostingTrace, attrs: Record<string, string | number>) {
      if (!tracer || !(t.sampled || 'error' in attrs)) return;
      const span = tracer.startSpan('posting', { startTime: t.startWall, attributes: { ...attrs, ...t.stageMs } });
      span.end(t.startWall + (performance.now() - t.startPerf));
    },
    dedup(result: string) { localDedup[result] = (localDedup[result] ?? 0) + 1; },
    fanout(n: number) { if (fanSeq++ % timeEvery === 0) fanoutH.observe(n); },
    normalizeFailed(board: string, reason: string) { normFail.labels(board, reason).inc(); },
    upstream(board: string, status: number, requestMs: number, poolWaitMs: number) {
      upReq.labels(board, String(status)).inc();
      upSec.labels(board).observe(requestMs / 1000);
      poolWait.labels(board).observe(poolWaitMs / 1000);
    },
    postToAlert(seconds: number) { p2a.observe(seconds); },
    queueWait(queue: string, waitsMs: number[]) { for (const w of waitsMs) if (waitSeq++ % timeEvery === 0) qWait.labels(queue).observe(w / 1000); },
    overflow(queue: string) { overflowC.labels(queue).inc(); },
    gauges(values: Record<string, number>) { for (const [k, v] of Object.entries(values)) gauge.labels(k).set(v); },
    flush() {
      for (const s of STAGES) if (localItems[s]) { itemsBy[s].inc(localItems[s]); localItems[s] = 0; }
      for (const r in localDedup) if (localDedup[r]) { dedupC.labels(r).inc(localDedup[r]); localDedup[r] = 0; }
    },
    metricsText: () => reg.metrics(),
    spansDropped: () => droppedSpans,
    async close() { await provider?.forceFlush(); await provider?.shutdown(); server?.close(); },
  };
}
```

`docker-compose.yml`:

```yaml
# Observability only (no Redis): OTel Collector -> Jaeger for traces; Prometheus scrapes the engine on :9464.
services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ["--config=/etc/otelcol/config.yaml"]
    volumes: ["./ops/otel-collector.yaml:/etc/otelcol/config.yaml:ro"]
    ports: ["4318:4318"]
    depends_on: [jaeger]
  jaeger:
    image: jaegertracing/jaeger:latest
    ports: ["16686:16686"]
  prometheus:
    image: prom/prometheus:latest
    command: ["--config.file=/etc/prometheus/prometheus.yml", "--enable-feature=exemplar-storage"]
    volumes: ["./ops/prometheus.yml:/etc/prometheus/prometheus.yml:ro"]
    ports: ["9090:9090"]
    extra_hosts: ["host.docker.internal:host-gateway"]
  grafana:
    image: grafana/grafana:latest
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
    volumes: ["./ops/grafana/datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml:ro"]
    ports: ["3000:3000"]
    depends_on: [prometheus, jaeger]
```

`ops/otel-collector.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch: {}
exporters:
  otlp:
    endpoint: jaeger:4317
    tls:
      insecure: true
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp]
```

`ops/prometheus.yml`:

```yaml
global:
  scrape_interval: 5s
scrape_configs:
  - job_name: load-radar-engine
    static_configs:
      - targets: ["host.docker.internal:9464"]
```

`ops/grafana/datasources.yaml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus:9090
    isDefault: true
  - name: Jaeger
    type: jaeger
    url: http://jaeger:16686
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/obs/obs.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Check the stack starts**

Run: `docker compose up -d && sleep 10 && curl -s localhost:9090/-/ready && curl -s -o /dev/null -w "%{http_code}\n" localhost:16686 && curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/health`
Expected: `Prometheus Server is Ready.`, then `200`, then `200`. Then `docker compose down`.

- [ ] **Step 6: Commit**

```bash
git add src/obs docker-compose.yml ops
git commit -m "feat(obs): lite metrics, own 1% sampling, one span per posting; local observability stack"
```

---

### Task 11: Engine wiring

**Files:**
- Create: `src/engine.ts`
- Test: `src/engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–10
- Produces:
  - `startEngine(cfg: EngineConfig): Promise<{ stop(): Promise<EngineSummary> }>`
  - `EngineConfig = { dataDir: string; boardsUrl: string; telegramUrl: string; clock: Clock; budgetPerMin: number; connectionsPerBoard: number; metricsPort: number | null; otlpEndpoint: string | null; sampleRate: number; maxUsers: number; bots: number }`
  - `EngineSummary = { polls: number; postings: number; newLoads: number; alertsQueued: number; alertsSent: number; alertsDropped: number; scheduler: SchedulerStats }`
  - CLI: `node src/engine.ts --data DIR --boards URL --telegram URL --sim-start ISO --real-start MS --speed X --budget N --connections N --metrics-port N --otlp URL|off --sample R --users N --bots N`; on SIGTERM/SIGINT prints `ENGINE_SUMMARY {json}` and exits.

- [ ] **Step 1: Write the failing test**

`src/engine.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createSimClock } from './shared/clock.ts';
import { startEngine } from './engine.ts';

test('engine polls, normalizes, matches and sends an alert end to end', async () => {
  const T0 = Date.parse('2026-11-04T15:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'lr-eng-'));
  writeFileSync(join(dir, 'searches.ndjson'), JSON.stringify({ user_id: 'U1', home: 'Chicago', credentials: [{ board: 'dat', credential_id: 'dat-1' }],
    searches: [{ search_id: 'S1', origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63 }, deadhead_mi: 75, dest: { kind: 'anywhere' }, equipment: 'van', min_rpm: null, pickup_within_days: 2, text: '' }] }) + '\n');
  const raw = { id: 'DAT-1', origin: 'Joliet, IL', dest: 'Atlanta, GA', equip: 'V', rate: 2000, trip_mi: 700, weight_lbs: 40000, pickup: '2026-11-04', posted: new Date(T0).toISOString(), comments: '', company: { name: 'B', mc: '1' } };
  const boards = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ now: T0 + 1, items: req.url!.includes('since=0') ? [raw] : [] })); });
  const sent: unknown[] = [];
  const telegram = createServer((req, res) => { const c: Buffer[] = []; req.on('data', (x) => c.push(x)); req.on('end', () => { sent.push(JSON.parse(Buffer.concat(c).toString())); res.writeHead(200); res.end('{"ok":true}'); }); });
  await new Promise<void>((r) => boards.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
  const engine = await startEngine({ dataDir: dir, boardsUrl: `http://127.0.0.1:${(boards.address() as AddressInfo).port}`, telegramUrl: `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`,
    clock: createSimClock({ simStart: T0, speed: 1 }), budgetPerMin: 600, connectionsPerBoard: 4, metricsPort: null, otlpEndpoint: null, sampleRate: 0, maxUsers: 0, bots: 1 });
  for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  const summary = await engine.stop();
  boards.close(); telegram.close();
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as any).chat_id, 'U1');
  assert.equal((sent[0] as any).meta.loads[0].loadKey, 'dat:DAT-1');
  assert.equal(summary.newLoads, 1);
  assert.equal(summary.alertsSent, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/engine.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/engine.ts`:

```ts
// The engine: every hot-path stage in one process, state in memory, stages joined by bounded queues (LLD §1, §4).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSimClock, type Clock } from './shared/clock.ts';
import { createBoundedQueue } from './shared/queue.ts';
import type { Alert, Load, PlanEntry, RawPosting } from './shared/types.ts';
import { loadUsers } from './data/users.ts';
import { loadGazetteer } from './normalize/gazetteer.ts';
import { createNormalizer } from './normalize/normalize.ts';
import { createDedup } from './dedup/dedup.ts';
import { buildMatcher } from './match/matcher.ts';
import { createHeat } from './plan/heat.ts';
import { allocate, buildPlan } from './plan/planner.ts';
import { createScheduler, type SchedulerStats } from './schedule/scheduler.ts';
import { createPoller } from './poll/poller.ts';
import { createAlertQueue } from './alerts/alert-queue.ts';
import { createNotifier } from './alerts/notifier.ts';
import { setupObs } from './obs/obs.ts';

export type EngineConfig = { dataDir: string; boardsUrl: string; telegramUrl: string; clock: Clock; budgetPerMin: number; connectionsPerBoard: number; metricsPort: number | null; otlpEndpoint: string | null; sampleRate: number; maxUsers: number; bots: number };
export type EngineSummary = { polls: number; postings: number; newLoads: number; alertsQueued: number; alertsSent: number; alertsDropped: number; scheduler: SchedulerStats };

const here = dirname(fileURLToPath(import.meta.url));
const summarize = (l: Load) => `${l.origin.city}, ${l.origin.state} → ${l.dest.city}, ${l.dest.state} · ${l.equipment} · ${l.rate ? `$${l.rate}` : 'no rate'} · ${l.miles} mi · pickup ${l.pickupDate}`;

export async function startEngine(cfg: EngineConfig) {
  const { clock } = cfg;
  const all = loadUsers(join(cfg.dataDir, 'searches.ndjson'));
  const users = cfg.maxUsers > 0 ? all.slice(0, cfg.maxUsers) : all;
  const obs = setupObs({ sampleRate: cfg.sampleRate, otlpEndpoint: cfg.otlpEndpoint, metricsPort: cfg.metricsPort });
  const normalize = createNormalizer(loadGazetteer(join(here, '../sim/data')));
  const dedup = createDedup(clock);
  const matcher = buildMatcher(users.flatMap((u) => u.searches));
  const heat = createHeat(clock);
  const alertQueue = createAlertQueue({ clock, freshAfterMs: 10_000, deadlineMs: 10 * 60_000, ttlMs: 72 * 3_600_000 });
  const counts = { polls: 0, postings: 0, newLoads: 0, alertsQueued: 0, alertsSent: 0 };

  const pollQueue = createBoundedQueue<PlanEntry>(20_000);
  const rawQueue = createBoundedQueue<RawPosting>(100_000);
  const scheduler = createScheduler({ clock, budgetPerMin: cfg.budgetPerMin, dispatch: (e) => pollQueue.tryPush(e) });
  const rebuildPlans = () => {
    for (const u of users) {
      const plan = buildPlan(u, heat.get);
      for (const c of u.credentials) scheduler.setEntries(c.credentialId, allocate(plan.filter((e) => e.credentialId === c.credentialId), cfg.budgetPerMin));
    }
  };
  rebuildPlans();

  const poller = createPoller({ baseUrl: cfg.boardsUrl, connectionsPerBoard: cfg.connectionsPerBoard, clock, timeoutMs: 5_000,
    onResponse: (e, r) => {
      counts.polls++;
      scheduler.report(e.credentialId, r.status, r.retryAfterSec);
      obs.upstream(e.board, r.status, r.requestMs, r.poolWaitMs);
      for (const raw of r.items) {
        if (!rawQueue.tryPush({ board: e.board, credentialId: e.credentialId, userId: e.userId, entryId: e.entryId, fetchedAt: clock.now(), raw })) obs.overflow('raw');
      }
    } });

  const processOne = (r: RawPosting) => {
    counts.postings++;
    const t = obs.begin();
    const n = obs.stage('normalize', t, () => normalize(r));
    if (!n.ok) { obs.normalizeFailed(r.board, n.reason); obs.finish(t, { board: r.board, error: n.reason }); return; }
    const load = n.load;
    const d = obs.stage('dedup', t, () => dedup(load));
    obs.dedup(d.result);
    if (d.result === 'refresh' || d.result === 'updated') { obs.finish(t, { board: load.board, dedup: d.result }); return; }
    if (d.result === 'new') { counts.newLoads++; heat.record(load.origin.cell4.slice(0, 3), load.equipment); }
    const m = obs.stage('match', t, () => matcher.match(load));
    obs.fanout(m.candidates);
    let offered = 0;
    obs.stage('alert', t, () => {
      for (const [userId, searchIds] of m.users) {
        const a: Alert = { userId, canonicalId: load.canonicalId, loadKey: load.key, searchIds, summary: summarize(load), postedAt: load.postedAt, enqueuedAt: clock.now() };
        if (alertQueue.offer(a)) offered++;
      }
    });
    counts.alertsQueued += offered;
    obs.finish(t, { board: load.board, dedup: d.result, candidates: m.candidates, alerts: offered });
  };

  const notifier = createNotifier({ clock, queue: alertQueue, bots: cfg.bots, perBotPerSec: 30, perChatPerSec: 1, maxDigest: 5,
    send: async (botId, chatId, alerts) => {
      try {
        const res = await fetch(`${cfg.telegramUrl}/bot${botId}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: alerts.map((x) => x.summary).join('\n'), meta: { loads: alerts.map((x) => ({ loadKey: x.loadKey, canonicalId: x.canonicalId, postedAt: x.postedAt })) } }) });
        if (res.status === 429) { const j = (await res.json()) as { parameters?: { retry_after?: number } }; return { ok: false, retryAfterSec: j.parameters?.retry_after ?? 1 }; }
        await res.arrayBuffer();
        return { ok: res.ok };
      } catch { return { ok: false, retryAfterSec: 1 }; }
    },
    onSent: (alerts, at) => { counts.alertsSent += alerts.length; for (const x of alerts) obs.postToAlert((at - x.postedAt) / 1000); } });

  let running = true;
  const maxInFlight = cfg.connectionsPerBoard * 4;
  const pumpPolls = async () => {
    while (running) {
      await Promise.race([pollQueue.waitForItems(), new Promise((r) => setTimeout(r, 50))]);
      while (running && pollQueue.size() && poller.inFlight() < maxInFlight) {
        for (const e of pollQueue.takeBatch(maxInFlight - poller.inFlight()).items) void poller.poll(e);
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  const pumpProcessing = async () => {
    while (running) {
      await Promise.race([rawQueue.waitForItems(), new Promise((r) => setTimeout(r, 50))]);
      const { items, waitsMs } = rawQueue.takeBatch(500);
      for (const r of items) processOne(r);
      obs.queueWait('raw', waitsMs);
      obs.flush();
      await new Promise((r) => setImmediate(r));
    }
  };
  // Sleep in short real-time chunks so stop() is noticed quickly (a 10-minute sleep would keep the process alive).
  const loop = async (fn: () => unknown, simMs: number) => {
    while (running) {
      await fn();
      const until = clock.now() + Math.max(simMs, 5 * clock.speed);
      while (running && clock.now() < until) await clock.sleep(Math.min(until - clock.now(), 200 * clock.speed));
    }
  };

  void pumpPolls();
  void pumpProcessing();
  void loop(() => scheduler.tick(), 20);
  void loop(() => notifier.tick(), 50);
  void loop(() => rebuildPlans(), 10 * 60_000);
  const gaugeTimer = setInterval(() => {
    const s = scheduler.stats();
    obs.gauges({ poll_queue: pollQueue.size(), raw_queue: rawQueue.size(), alert_queue: alertQueue.size(), alert_queue_oldest_wait_ms: alertQueue.oldestWaitMs(),
      alerts_dropped_stale: alertQueue.dropped(), polls_in_flight: poller.inFlight(), logins_paused: s.paused, logins_banned: s.banned, scheduler_stretch: s.stretch, notifier_held: notifier.held() });
  }, 1_000);

  return {
    async stop(): Promise<EngineSummary> {
      running = false;
      clearInterval(gaugeTimer);
      await poller.close();
      await obs.close();
      return { ...counts, alertsDropped: alertQueue.dropped(), scheduler: scheduler.stats() };
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: {
    data: { type: 'string', default: 'out' }, boards: { type: 'string', default: 'http://127.0.0.1:7001' }, telegram: { type: 'string', default: 'http://127.0.0.1:7002' },
    'sim-start': { type: 'string' }, 'real-start': { type: 'string' }, speed: { type: 'string', default: '1' }, budget: { type: 'string', default: '60' },
    connections: { type: 'string', default: '64' }, 'metrics-port': { type: 'string', default: '9464' }, otlp: { type: 'string', default: 'off' },
    sample: { type: 'string', default: '0.01' }, users: { type: 'string', default: '0' }, bots: { type: 'string', default: '4' } } });
  const clock = createSimClock({ simStart: Date.parse(a['sim-start']!), realStart: Number(a['real-start']), speed: Number(a.speed) });
  const engine = await startEngine({ dataDir: a.data!, boardsUrl: a.boards!, telegramUrl: a.telegram!, clock, budgetPerMin: Number(a.budget),
    connectionsPerBoard: Number(a.connections), metricsPort: Number(a['metrics-port']) || null, otlpEndpoint: a.otlp === 'off' ? null : a.otlp!,
    sampleRate: Number(a.sample), maxUsers: Number(a.users), bots: Number(a.bots) });
  console.log('engine started');
  const stop = async () => { console.log(`ENGINE_SUMMARY ${JSON.stringify(await engine.stop())}`); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/engine.test.ts`
Expected: PASS, 1 test (within ~10 s).

- [ ] **Step 5: Run the whole unit suite**

Run: `npm test`
Expected: all tests in `src/`, `sims/`, `scorer/` pass (scorer has none yet).

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "feat(engine): wire scheduler, pollers, pipeline stages and notifier"
```

---

### Task 12: Scorer, launcher and end-to-end run

**Files:**
- Create: `scorer/score.ts`, `scripts/run.ts`
- Test: `scorer/score.test.ts`, `tests/e2e.test.ts`

**Interfaces:**
- Consumes: `loadUsers`, `specMatches`, `coverCells`, `geohash`, `coverTime`, `Delivery`; engine and sim CLIs
- Produces:
  - `score(input: { truthFile: string; searchesFile: string; deliveriesFile: string; windowStart: number; windowEnd: number; settleMs: number }): ScoreReport`
  - `ScoreReport = { expected: number; delivered: number; missed: number; missRate: number; missedOpen5Min: number; duplicates: number; duplicateRate: number; unexpected: number; latencySec: { p50: number; p95: number; p99: number } }`
  - Launcher CLI: `node scripts/run.ts --data DIR --speed X --minutes M [--budget N] [--connections N] [--users N] [--otlp URL|off] [--port-base 7001]`; last stdout line is `RUN_RESULT {json}` with `{ score, boards, engine }`.

Expected alerts = (user, load) pairs where the load was first posted inside the window (and at least `settleMs` before its end), one of the user's searches matches it (`specMatches`), and the user has a login on at least one board that carried it.

- [ ] **Step 1: Write the failing scorer test**

`scorer/score.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { score } from './score.ts';

test('scorer counts deliveries, misses, duplicates and latency', () => {
  const T0 = Date.parse('2026-11-04T15:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'lr-score-'));
  const load = (id: string, lat: number, lon: number) => ({ load_id: id, origin: { city: 'X', state: 'IL', lat, lon }, dest: { city: 'Y', state: 'GA', lat: 33.75, lon: -84.39 },
    equipment: 'van', miles: 700, rate: 2000, pickup_date: '2026-11-04', first_posted_at: new Date(T0).toISOString(), postings: [{ board: 'dat', board_load_id: id, posted_at: new Date(T0).toISOString() }] });
  writeFileSync(join(dir, 'truth.ndjson'), [load('L1', 41.88, -87.63), load('L2', 41.9, -87.7), load('L3', 30, -95)].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(dir, 'searches.ndjson'), JSON.stringify({ user_id: 'U1', home: 'Chicago', credentials: [{ board: 'dat', credential_id: 'd1' }],
    searches: [{ search_id: 'S1', origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63 }, deadhead_mi: 50, dest: { kind: 'anywhere' }, equipment: 'van', min_rpm: null, pickup_within_days: 2, text: '' }] }) + '\n');
  const d = (at: number, key: string) => JSON.stringify({ botId: '0', chatId: 'U1', at, loads: [{ loadKey: key, canonicalId: 'C', postedAt: T0 }] });
  writeFileSync(join(dir, 'deliveries.ndjson'), [d(T0 + 10_000, 'dat:L1'), d(T0 + 20_000, 'dat:L1')].join('\n') + '\n');
  const r = score({ truthFile: join(dir, 'truth.ndjson'), searchesFile: join(dir, 'searches.ndjson'), deliveriesFile: join(dir, 'deliveries.ndjson'), windowStart: T0 - 1, windowEnd: T0 + 3_600_000, settleMs: 600_000 });
  assert.equal(r.expected, 2);          // L1 and L2 are near Chicago; L3 is in Texas
  assert.equal(r.delivered, 1);
  assert.equal(r.missed, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.latencySec.p50, 10);
  assert.equal(r.unexpected, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scorer/score.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the scorer**

`scorer/score.ts`:

```ts
// Compares delivered alerts with the generator's answer key (LLD §15): latency, misses, duplicates.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadUsers } from '../src/data/users.ts';
import { specMatches, type MatchableLoad } from '../src/match/filters.ts';
import { coverCells, geohash } from '../src/shared/geo.ts';
import { coverTime } from '../sims/cover.ts';
import type { Delivery } from '../sims/telegram-sim.ts';

export type ScoreReport = { expected: number; delivered: number; missed: number; missRate: number; missedOpen5Min: number; duplicates: number; duplicateRate: number; unexpected: number; latencySec: { p50: number; p95: number; p99: number } };
type TruthLoad = MatchableLoad & { id: string; boards: Set<string>; coveredAt: number };

const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()) : []);
const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

export function score(input: { truthFile: string; searchesFile: string; deliveriesFile: string; windowStart: number; windowEnd: number; settleMs: number }): ScoreReport {
  const keyToLoad = new Map<string, string>();
  const byCell = new Map<string, TruthLoad[]>();
  const loads = new Map<string, TruthLoad>();
  for (const line of lines(input.truthFile)) {
    const l = JSON.parse(line);
    for (const p of l.postings) keyToLoad.set(`${p.board}:${p.board_load_id}`, l.load_id);
    const first = Date.parse(l.first_posted_at);
    if (first < input.windowStart || first > input.windowEnd - input.settleMs) continue;
    const t: TruthLoad = { id: l.load_id, boards: new Set(l.postings.filter((p: any) => Date.parse(p.posted_at) <= input.windowEnd).map((p: any) => p.board)),
      coveredAt: coverTime(l.load_id, first), postedAt: first, equipment: l.equipment, rate: l.rate, miles: l.miles, pickupDate: l.pickup_date,
      origin: { ...l.origin, cell4: geohash(l.origin.lat, l.origin.lon, 4) }, dest: { ...l.dest, cell4: geohash(l.dest.lat, l.dest.lon, 4) } };
    loads.set(t.id, t);
    const c = geohash(t.origin.lat, t.origin.lon, 3);
    if (!byCell.has(c)) byCell.set(c, []);
    byCell.get(c)!.push(t);
  }
  const expected = new Set<string>();
  for (const u of loadUsers(input.searchesFile)) {
    const boards = new Set(u.credentials.map((c) => c.board));
    for (const s of u.searches) for (const cell of coverCells(s.lat, s.lon, s.deadheadMi, 3)) for (const l of byCell.get(cell) ?? []) {
      if ([...l.boards].some((b) => boards.has(b)) && specMatches(s, l)) expected.add(`${u.userId}|${l.id}`);
    }
  }
  const first = new Map<string, number>();
  let duplicates = 0, unexpected = 0;
  for (const line of lines(input.deliveriesFile)) {
    const d: Delivery = JSON.parse(line);
    for (const x of d.loads) {
      const loadId = keyToLoad.get(x.loadKey);
      if (!loadId) continue;
      const k = `${d.chatId}|${loadId}`;
      if (first.has(k)) { duplicates++; continue; }
      first.set(k, d.at);
      if (!expected.has(k)) unexpected++;
    }
  }
  const lat: number[] = [];
  let missed = 0, missedOpen5Min = 0;
  for (const k of expected) {
    const at = first.get(k);
    const l = loads.get(k.split('|')[1])!;
    if (at === undefined) { missed++; if (l.coveredAt - l.postedAt >= 5 * 60_000) missedOpen5Min++; continue; }
    lat.push((at - l.postedAt) / 1000);
  }
  lat.sort((a, b) => a - b);
  const delivered = expected.size - missed;
  return { expected: expected.size, delivered, missed, missRate: expected.size ? missed / expected.size : 0, missedOpen5Min,
    duplicates, duplicateRate: delivered ? duplicates / delivered : 0, unexpected, latencySec: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { truth: { type: 'string' }, searches: { type: 'string' }, deliveries: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, settle: { type: 'string', default: '600000' } } });
  console.log(JSON.stringify(score({ truthFile: a.truth!, searchesFile: a.searches!, deliveriesFile: a.deliveries!, windowStart: Date.parse(a.start!), windowEnd: Date.parse(a.end!), settleMs: Number(a.settle) }), null, 2));
}
```

- [ ] **Step 4: Run scorer test to verify it passes**

Run: `node --test scorer/score.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Implement the launcher**

`scripts/run.ts`:

```ts
// Launch boards-sim + telegram-sim + engine on one simulated clock, run for --minutes (real), then score.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { score } from '../scorer/score.ts';

const { values: a } = parseArgs({ options: {
  data: { type: 'string', default: 'out' }, speed: { type: 'string', default: '30' }, minutes: { type: 'string', default: '5' },
  budget: { type: 'string', default: '60' }, connections: { type: 'string', default: '64' }, users: { type: 'string', default: '0' },
  otlp: { type: 'string', default: 'off' }, sample: { type: 'string', default: '0.01' }, 'port-base': { type: 'string', default: '7001' },
  'metrics-port': { type: 'string', default: '9464' } } });
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(a.data!, 'meta.json'), 'utf8'));
const speed = Number(a.speed), minutes = Number(a.minutes), base = Number(a['port-base']);
const simStart = Date.parse(meta.start);
const realStart = Date.now() + 3_000;                      // children start on the same simulated clock
const runDir = join(a.data!, 'run');
mkdirSync(runDir, { recursive: true });
const deliveries = join(runDir, 'deliveries.ndjson');
rmSync(deliveries, { force: true });
const clockArgs = ['--sim-start', new Date(simStart).toISOString(), '--real-start', String(realStart), '--speed', String(speed)];
const boardsUrl = `http://127.0.0.1:${base}`, telegramUrl = `http://127.0.0.1:${base + 1}`;
const node = (file: string, args: string[]): ChildProcess => spawn(process.execPath, [join(root, file), ...args], { stdio: ['ignore', 'pipe', 'inherit'] });

const boards = node('sims/boards-sim.ts', ['--data', a.data!, '--port', String(base), '--budget', a.budget!, ...clockArgs]);
const telegram = node('sims/telegram-sim.ts', ['--port', String(base + 1), '--log', deliveries, ...clockArgs]);
const engine = node('src/engine.ts', ['--data', a.data!, '--boards', boardsUrl, '--telegram', telegramUrl, '--budget', a.budget!, '--connections', a.connections!,
  '--users', a.users!, '--otlp', a.otlp!, '--sample', a.sample!, '--metrics-port', a['metrics-port']!, ...clockArgs]);
let engineSummary: unknown = null;
engine.stdout!.on('data', (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.startsWith('ENGINE_SUMMARY ')) engineSummary = JSON.parse(l.slice(15)); else if (l.trim()) console.error(`[engine] ${l}`); });
boards.stdout!.on('data', (b: Buffer) => console.error(`[boards] ${b.toString().trim()}`));
telegram.stdout!.on('data', (b: Buffer) => console.error(`[telegram] ${b.toString().trim()}`));

await new Promise((r) => setTimeout(r, 3_000 + minutes * 60_000));
const boardStats = await fetch(`${boardsUrl}/stats`).then((r) => r.json()).catch(() => null);
const exited = new Promise((r) => engine.on('exit', r));
engine.kill('SIGTERM');
await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
boards.kill('SIGTERM');
telegram.kill('SIGTERM');

const windowEnd = simStart + minutes * 60_000 * speed;
const report = score({ truthFile: join(a.data!, 'truth.ndjson'), searchesFile: join(a.data!, 'searches.ndjson'), deliveriesFile: deliveries, windowStart: simStart, windowEnd, settleMs: 10 * 60_000 });
const result = { config: { speed, minutes, simHours: (minutes * speed) / 60, budget: Number(a.budget), connections: Number(a.connections) }, score: report, boards: boardStats, engine: engineSummary };
writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 2));
console.log(`RUN_RESULT ${JSON.stringify(result)}`);
```

- [ ] **Step 6: Write the end-to-end test**

`tests/e2e.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('full run on a small generated dataset: alerts delivered, no bans', { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-e2e-'));
  const gen = spawnSync(process.execPath, [join(root, 'sim/gen.ts'), '--loads', '3000', '--users', '100', '--hours', '2', '--out', dir], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const run = spawnSync(process.execPath, [join(root, 'scripts/run.ts'), '--data', dir, '--speed', '60', '--minutes', '1.5', '--port-base', '17001', '--metrics-port', '19464'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split('\n').find((l) => l.startsWith('RUN_RESULT '))!;
  const result = JSON.parse(line.slice(11));
  console.log(JSON.stringify(result.score));
  assert.ok(result.score.expected > 0, 'some alerts were expected');
  assert.ok(result.score.delivered > 0, 'some alerts were delivered');
  assert.equal(result.boards.bannedLogins, 0, 'no login was banned');
  assert.ok(result.score.missRate < 0.5, `miss rate ${result.score.missRate}`);
});
```

- [ ] **Step 7: Run the end-to-end test**

Run: `npm run test:e2e`
Expected: PASS within about 2 minutes, printing a score line such as `{"expected":…,"delivered":…,"missRate":…,"latencySec":{…}}`. If `missRate` is above 0.5, the cause is real (read `out-…/run/result.json`: scheduler stats, dropped alerts) and goes into the Day 2 analysis; do not loosen the assertion without writing down why.

- [ ] **Step 8: Commit**

```bash
git add scorer scripts tests
git commit -m "feat: scorer, launcher and end-to-end run against the answer key"
```

---

### Task 13: Document how to run it, and reconcile the docs

**Files:**
- Modify: `README.md` (add a "Run it" section before "9. Where to read more")
- Modify: `DESIGN.md` §8 build plan checkboxes
- Modify: `LLD.md` §6.3 backoff row

- [ ] **Step 1: Add the run instructions to `README.md`**

Insert before the line `## 9. Where to read more`:

````markdown
## Run it

```bash
npm install
npm test                 # unit tests
npm run gen:small        # 8,000 loads, 300 users, 2 hours -> out-small/
node scripts/run.ts --data out-small --speed 30 --minutes 3
npm run test:e2e         # generates its own data, ~2 minutes
```

The last line printed is `RUN_RESULT {...}`: alerts expected vs delivered, misses, duplicates, latency (simulated seconds), board stats (429s, bans) and engine counters. The same JSON is written to `out-small/run/result.json`.

With observability: `npm run obs:up`, then add `--otlp http://127.0.0.1:4318/v1/traces` to the run. Prometheus is on :9090, Grafana on :3000, Jaeger on :16686. The engine serves metrics on :9464.
````

- [ ] **Step 2: Update the build plan in `DESIGN.md` §8**

Replace the four unchecked Day 1 items with:

```markdown
- [x] `docker compose`: OTel Collector, Prometheus, Grafana, Jaeger (observability only; no Redis)
- [x] Board simulator (budgets, 429s, bans, covered loads) and Telegram simulator
- [x] Scheduler + pollers, normalizer, dedup (rule; classifier on Day 2), matcher, alert queue, notifier
- [x] Observability on every stage (lite metrics, own 1% sampling, 1 span per posting) and an end-to-end scored run
```

- [ ] **Step 3: Fix the backoff rule in `LLD.md` §6.3**

Replace the row:

```markdown
| `429` | `consecutive429++`, `pausedUntil = now + min(Retry-After, 2^n × 5 s, 15 min)` with jitter |
```

with:

```markdown
| `429` | `consecutive429++`, `pausedUntil = now + min(15 min, max(Retry-After, 2^n × 5 s))` with jitter. Waiting less than the board's Retry-After only earns more 429s |
```

- [ ] **Step 4: Run all tests once more**

Run: `npm test && npm run test:e2e`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md DESIGN.md LLD.md
git commit -m "docs: how to run the pipeline; Day 1 build plan done; backoff waits at least Retry-After"
```
