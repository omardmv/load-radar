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
