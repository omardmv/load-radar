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
