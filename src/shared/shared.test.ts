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
