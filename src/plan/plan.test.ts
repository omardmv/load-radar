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
