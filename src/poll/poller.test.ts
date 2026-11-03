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
