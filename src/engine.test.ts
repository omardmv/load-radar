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

test('the same posting fetched with two customers\' logins alerts both customers', async () => {
  const T0 = Date.parse('2026-11-04T15:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'lr-eng-'));
  const user = (id: string) => JSON.stringify({ user_id: id, home: 'Chicago', credentials: [{ board: 'dat', credential_id: `dat-${id}` }],
    searches: [{ search_id: `S-${id}`, origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63 }, deadhead_mi: 75, dest: { kind: 'anywhere' }, equipment: 'van', min_rpm: null, pickup_within_days: 2, text: '' }] });
  writeFileSync(join(dir, 'searches.ndjson'), [user('U1'), user('U2')].join('\n') + '\n');
  const raw = { id: 'DAT-1', origin: 'Joliet, IL', dest: 'Atlanta, GA', equip: 'V', rate: 2000, trip_mi: 700, weight_lbs: 40000, pickup: '2026-11-04', posted: new Date(T0).toISOString(), comments: '', company: { name: 'B', mc: '1' } };
  const boards = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ now: T0 + 1, items: req.url!.includes('since=0') ? [raw] : [] })); });
  const sent: any[] = [];
  const telegram = createServer((req, res) => { const c: Buffer[] = []; req.on('data', (x) => c.push(x)); req.on('end', () => { sent.push(JSON.parse(Buffer.concat(c).toString())); res.writeHead(200); res.end('{"ok":true}'); }); });
  await new Promise<void>((r) => boards.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
  const engine = await startEngine({ dataDir: dir, boardsUrl: `http://127.0.0.1:${(boards.address() as AddressInfo).port}`, telegramUrl: `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`,
    clock: createSimClock({ simStart: T0, speed: 1 }), budgetPerMin: 600, connectionsPerBoard: 4, metricsPort: null, otlpEndpoint: null, sampleRate: 0, maxUsers: 0, bots: 1 });
  for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  const summary = await engine.stop();
  boards.close(); telegram.close();
  assert.deepEqual(sent.map((m) => m.chat_id).sort(), ['U1', 'U2']);
  assert.equal(summary.newLoads, 1);           // still one real load
});
