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
