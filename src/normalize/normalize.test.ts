import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGazetteer } from './gazetteer.ts';
import { createNormalizer } from './normalize.ts';
import type { RawPosting } from '../shared/types.ts';

const lookup = loadGazetteer(join(dirname(fileURLToPath(import.meta.url)), '../../sim/data'));
const normalize = createNormalizer(lookup);
const raw = (board: RawPosting['board'], r: unknown, userId: string | null = 'U1'): RawPosting =>
  ({ board, credentialId: userId ? 'c1' : null, userId, entryId: 'e1', fetchedAt: 0, raw: r });

test('dat format', () => {
  const r = normalize(raw('dat', { id: 'DAT-1', origin: 'Chicago, IL', dest: 'Atlanta, GA', equip: 'V', rate: 1950, trip_mi: 716, weight_lbs: 40000, pickup: '2026-11-04', posted: '2026-11-04T15:00:00.000Z', comments: '', company: { name: 'X', mc: '123' } }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.load.key, 'dat:DAT-1');
  assert.equal(r.load.equipment, 'van');
  assert.equal(r.load.rate, 1950);
  assert.equal(r.load.miles, 716);
  assert.equal(r.load.origin.cell4, 'dp3w');
  assert.equal(r.load.postedAt, Date.parse('2026-11-04T15:00:00.000Z'));
  assert.deepEqual(r.load.visibleTo, { kind: 'user', userId: 'U1' });
  assert.equal(r.load.canonicalId, '');
});

test('truckstop format: upper case, names cut at 14 characters, "$0" means no rate', () => {
  const r = normalize(raw('truckstop', { loadId: 55, originCity: 'BILLINGTON HEI', originState: 'NY', destinationCity: 'CHICAGO', destinationState: 'IL', equipmentType: 'FLATBED/STEP DECK', paymentAmount: '$0', mileage: 520, weight: '44,000 lbs', pickupDate: '11/05/2026', postedAt: 1793800000000, specInfo: '', broker: { companyName: 'Y', mcNumber: 'MC777' } }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.load.origin.city, 'Billington Heights');
  assert.equal(r.load.rate, null);
  assert.equal(r.load.equipment, 'flatbed');
  assert.equal(r.load.brokerMc, '777');
  assert.equal(r.load.pickupDate, '2026-11-05');
});

test('portal_a and portal_b formats; portal_b weight is in thousands', () => {
  const a = normalize(raw('portal_a', { ref: 'PA1', lane: { from: { city: 'St Louis', st: 'MO' }, to: { city: 'Dallas', st: 'TX' } }, mode: "Reefer 53'", price: { amount: 2100, currency: 'USD' }, pu: { earliest: '2026-11-04T06:00:00-06:00', latest: '2026-11-04T18:00:00-06:00' }, created: '2026-11-04T12:00:00.000Z', notes: '', broker_mc: '9' }));
  assert.ok(a.ok);
  if (a.ok) { assert.equal(a.load.origin.city, 'St. Louis'); assert.equal(a.load.equipment, 'reefer'); assert.ok(a.load.miles > 500); }
  const b = normalize(raw('portal_b', { ref: 'PB1', pickup_date: '11-04-2026', origin: 'LA, CA', destination: 'PHOENIX, AZ', equipment: 'Van', rate: '$1,200', weight: '38.00 lbs', size: 'Full', company: 'Z', mc: '5', details: '', created_at: 1793800000 }, null));
  assert.ok(b.ok);
  if (b.ok) { assert.equal(b.load.origin.city, 'Los Angeles'); assert.equal(b.load.rate, 1200); assert.deepEqual(b.load.visibleTo, { kind: 'all' }); assert.equal(b.load.postedAt, 1793800000000); }
});

test('unknown place and unknown equipment are rejected with a reason', () => {
  const p = normalize(raw('dat', { id: 'D2', origin: 'Nowhereville, ZZ', dest: 'Atlanta, GA', equip: 'V', rate: 1, trip_mi: 1, weight_lbs: 1, pickup: '2026-11-04', posted: '2026-11-04T15:00:00Z', comments: '', company: { name: 'X', mc: '1' } }));
  assert.deepEqual(p, { ok: false, reason: 'place' });
  const e = normalize(raw('dat', { id: 'D3', origin: 'Chicago, IL', dest: 'Atlanta, GA', equip: 'TANKER', rate: 1, trip_mi: 1, weight_lbs: 1, pickup: '2026-11-04', posted: '2026-11-04T15:00:00Z', comments: '', company: { name: 'X', mc: '1' } }));
  assert.deepEqual(e, { ok: false, reason: 'equipment' });
});
