import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from '../shared/clock.ts';
import { createDedup } from './dedup.ts';
import type { Load } from '../shared/types.ts';

const T0 = Date.parse('2026-11-04T15:00:00Z');
const base = (over: Partial<Load> = {}): Load => ({
  key: 'dat:1', board: 'dat', boardLoadId: '1', brokerMc: '100',
  origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63, cell4: 'dp3w' },
  dest: { city: 'Atlanta', state: 'GA', lat: 33.75, lon: -84.39, cell4: 'dn5b' },
  equipment: 'van', equipmentDetail: 'V', rate: 1950, miles: 716, pickupDate: '2026-11-04',
  postedAt: T0, contentHash: 'h1', visibleTo: { kind: 'all' }, canonicalId: '', ...over,
});

test('same posting seen again is a refresh; edited posting is an update of the same canonical load', () => {
  const dedup = createDedup(createFakeClock(T0));
  const first = dedup(base());
  assert.equal(first.result, 'new');
  assert.equal(dedup(base()).result, 'refresh');
  const upd = dedup(base({ contentHash: 'h2', rate: 2000 }));
  assert.equal(upd.result, 'updated');
  assert.equal(upd.canonicalId, first.canonicalId);
});

test('cross-post on another board by the same broker merges', () => {
  const dedup = createDedup(createFakeClock(T0));
  const a = dedup(base());
  const b = dedup(base({ key: 'truckstop:9', board: 'truckstop', boardLoadId: '9', contentHash: 'x', rate: 1975, postedAt: T0 + 90_000 }));
  assert.equal(b.result, 'merged');
  assert.equal(b.canonicalId, a.canonicalId);
});

test('co-broker copy at a lower rate merges; a different broker at the same rate does not', () => {
  const dedup = createDedup(createFakeClock(T0));
  const a = dedup(base());
  const co = dedup(base({ key: 'dat:2', boardLoadId: '2', brokerMc: '200', contentHash: 'y', rate: 1800, postedAt: T0 + 600_000 }));
  assert.equal(co.result, 'merged');
  assert.equal(co.canonicalId, a.canonicalId);
  const other = dedup(base({ key: 'dat:3', boardLoadId: '3', brokerMc: '300', contentHash: 'z', rate: 1950, postedAt: T0 + 600_000 }));
  assert.equal(other.result, 'new');
});

test('recurring freight on the next pickup day is a separate load', () => {
  const dedup = createDedup(createFakeClock(T0));
  const a = dedup(base());
  const sib = dedup(base({ key: 'dat:4', boardLoadId: '4', contentHash: 'w', pickupDate: '2026-11-05', postedAt: T0 + 60_000 }));
  assert.equal(sib.result, 'new');
  assert.notEqual(sib.canonicalId, a.canonicalId);
});
