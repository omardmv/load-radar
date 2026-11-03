import { createHash } from 'node:crypto';
import { geohash, milesBetween } from '../shared/geo.ts';
import type { Board, Equip, Load, RawPosting } from '../shared/types.ts';
import type { PlaceHit } from './gazetteer.ts';

const EQUIP: Record<string, Equip> = {
  V: 'van', VR: 'van', R: 'reefer', F: 'flatbed', FD: 'flatbed', VAN: 'van', 'VAN/REEFER': 'van', REEFER: 'reefer', FLATBED: 'flatbed',
  'STEP DECK': 'flatbed', 'FLATBED/STEP DECK': 'flatbed', 'FLATBED (W/TARPS)': 'flatbed', "DRY VAN 53'": 'van', "REEFER 53'": 'reefer',
  "FLATBED 48'": 'flatbed', "STEP DECK 48'": 'flatbed',
};
const money = (s: unknown): number | null => {
  if (s == null || s === '') return null;
  const n = typeof s === 'number' ? s : Number(String(s).replace(/[$,]/g, ''));
  return n > 0 ? n : null;
};
const splitPlace = (s: string) => { const i = s.lastIndexOf(','); return [s.slice(0, i).trim(), s.slice(i + 1).trim()]; };
const mdy = (s: string, sep: string) => { const [m, d, y] = s.split(sep); return `${y}-${m}-${d}`; };

export function rawId(board: Board, raw: any): string {
  return board === 'dat' ? raw.id : board === 'truckstop' ? String(raw.loadId) : raw.ref;
}

export type NormalizeResult = { ok: true; load: Load } | { ok: false; reason: 'place' | 'equipment' };

export function createNormalizer(lookup: (city: string, state: string) => PlaceHit | null) {
  return (p: RawPosting): NormalizeResult => {
    const r: any = p.raw;
    let oc: string, os: string, dc: string, ds: string, eq: string, rate: number | null, pickup: string, posted: number, mc: string, mi: number | null = null, detail: string;
    switch (p.board) {
      case 'dat': [oc, os] = splitPlace(r.origin); [dc, ds] = splitPlace(r.dest); eq = r.equip; rate = money(r.rate); pickup = r.pickup; posted = Date.parse(r.posted); mc = r.company.mc; mi = r.trip_mi; detail = r.equip; break;
      case 'truckstop': oc = r.originCity; os = r.originState; dc = r.destinationCity; ds = r.destinationState; eq = r.equipmentType; rate = money(r.paymentAmount); pickup = mdy(r.pickupDate, '/'); posted = r.postedAt; mc = String(r.broker.mcNumber).replace(/^MC/, ''); mi = r.mileage; detail = r.equipmentType; break;
      case 'portal_a': oc = r.lane.from.city; os = r.lane.from.st; dc = r.lane.to.city; ds = r.lane.to.st; eq = r.mode; rate = money(r.price?.amount); pickup = r.pu.earliest.slice(0, 10); posted = Date.parse(r.created); mc = r.broker_mc; detail = r.mode; break;
      default: [oc, os] = splitPlace(r.origin); [dc, ds] = splitPlace(r.destination); eq = r.equipment; rate = money(r.rate); pickup = mdy(r.pickup_date, '-'); posted = r.created_at * 1000; mc = r.mc; detail = r.equipment;
    }
    const equipment = EQUIP[String(eq).toUpperCase()];
    if (!equipment) return { ok: false, reason: 'equipment' };
    const o = lookup(oc, os), d = lookup(dc, ds);
    if (!o || !d) return { ok: false, reason: 'place' };
    const id = rawId(p.board, r);
    const miles = mi ?? Math.round(milesBetween(o.lat, o.lon, d.lat, d.lon) * 1.17);
    const contentHash = createHash('sha1').update(`${p.board}|${id}|${rate}|${pickup}|${o.city}|${d.city}|${equipment}`).digest('base64');
    return { ok: true, load: {
      key: `${p.board}:${id}`, board: p.board, boardLoadId: id, brokerMc: String(mc),
      origin: { ...o, cell4: geohash(o.lat, o.lon, 4) }, dest: { ...d, cell4: geohash(d.lat, d.lon, 4) },
      equipment, equipmentDetail: String(detail), rate, miles, pickupDate: pickup, postedAt: posted, contentHash,
      visibleTo: p.userId ? { kind: 'user', userId: p.userId } : { kind: 'all' }, canonicalId: '',
    } };
  };
}
