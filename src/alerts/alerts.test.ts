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
