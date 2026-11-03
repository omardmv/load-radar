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
