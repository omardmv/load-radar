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
