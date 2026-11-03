// The CPU-bound core of the engine: normalize -> dedup -> match -> alert, all in memory (LLD sections 6.5–6.8).
// No HTTP to boards here: the overhead test measures what our own code and its observability cost.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type Equip = 'van' | 'reefer' | 'flatbed';
type Place = { lat: number; lon: number; city: string; state: string };
export type Load = {
  key: string; board: string; brokerMc: string; origin: Place & { cell: string }; dest: Place & { cell: string };
  equipment: Equip; rate: number | null; miles: number; pickupDate: string; postedAt: number; contentHash: string; canonicalId?: string;
};
type Spec = { id: string; userId: string; lat: number; lon: number; deadhead: number; dest: any; equipment: Equip; minRpm: number | null; days: number };

// ---------- geo ----------
const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function geohash(lat: number, lon: number, precision: number) {
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180, out = '', bit = 0, ch = 0, even = true;
  while (out.length < precision) {
    if (even) { const m = (lonLo + lonHi) / 2; if (lon >= m) { ch = (ch << 1) | 1; lonLo = m; } else { ch <<= 1; lonHi = m; } }
    else { const m = (latLo + latHi) / 2; if (lat >= m) { ch = (ch << 1) | 1; latLo = m; } else { ch <<= 1; latHi = m; } }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}
const R = Math.PI / 180;
export const miles = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const h = Math.sin((bLat - aLat) * R / 2) ** 2 + Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin((bLon - aLon) * R / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
};
// Level-4 cell size in degrees (for neighbor lookups) and level-3 cell size (for search covering).
const L4 = { dlat: 180 / 2 ** 10, dlon: 360 / 2 ** 10 }, L3 = { dlat: 180 / 2 ** 7, dlon: 360 / 2 ** 8 };
const neighbors4 = (lat: number, lon: number) => {
  const cells = new Set<string>();
  for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) cells.add(geohash(lat + a * L4.dlat, lon + b * L4.dlon, 4));
  return [...cells];
};

// ---------- gazetteer (place lookup) ----------
const norm = (s: string) => s.toUpperCase().replace(/[.,']/g, '').replace(/^SAINT /, 'ST ').replace(/^FORT /, 'FT ').replace(/^MOUNT /, 'MT ').replace(/\s+/g, ' ').trim();
const ALIASES: Record<string, string> = { 'LA': 'LOS ANGELES', 'VERNON': 'LOS ANGELES', 'KANSAS CTY': 'KANSAS CITY', 'ONTARIO (INLAND EMPIRE)': 'ONTARIO' };
export function loadGazetteer(dataDir: string) {
  const exact = new Map<string, Place>();
  const byState = new Map<string, [string, Place][]>();
  const add = (city: string, state: string, lat: number, lon: number) => {
    const k = `${norm(city)}|${state}`; if (exact.has(k)) return;
    const p = { lat, lon, city, state }; exact.set(k, p);
    if (!byState.has(state)) byState.set(state, []); byState.get(state)!.push([norm(city), p]);
  };
  for (const m of JSON.parse(readFileSync(join(dataDir, 'markets.json'), 'utf8')).markets) add(m.city, m.state, m.lat, m.lon);
  for (const t of JSON.parse(readFileSync(join(dataDir, 'towns.json'), 'utf8')).towns) add(t.name, t.state, t.lat, t.lon);
  return (city: string, state: string): Place | null => {
    let n = norm(city); n = ALIASES[n] ?? n;
    const hit = exact.get(`${n}|${state}`); if (hit) return hit;
    if (n.length === 14) for (const [name, p] of byState.get(state) ?? []) if (name.startsWith(n)) return p;   // truncated names
    return null;
  };
}

// ---------- normalizer: four board formats -> Load ----------
const EQUIP: Record<string, Equip> = {
  V: 'van', VR: 'van', R: 'reefer', F: 'flatbed', FD: 'flatbed', VAN: 'van', 'VAN/REEFER': 'van', REEFER: 'reefer', FLATBED: 'flatbed',
  'STEP DECK': 'flatbed', 'FLATBED/STEP DECK': 'flatbed', 'FLATBED (W/TARPS)': 'flatbed', "DRY VAN 53'": 'van', "REEFER 53'": 'reefer',
  "FLATBED 48'": 'flatbed', "STEP DECK 48'": 'flatbed',
};
const money = (s: string | number | null | undefined) => { if (s == null || s === '') return null; const n = typeof s === 'number' ? s : Number(String(s).replace(/[$,]/g, '')); return n > 0 ? n : null; };
const splitPlace = (s: string) => { const i = s.lastIndexOf(','); return [s.slice(0, i).trim(), s.slice(i + 1).trim()]; };
const mdy = (s: string, sep: string) => { const [m, d, y] = s.split(sep); return `${y}-${m}-${d}`; };
export type Counters = { unknownPlace: number; unknownEquip: number };

export function makeNormalizer(lookup: ReturnType<typeof loadGazetteer>, counters: Counters) {
  return (board: string, r: any): Load | null => {
    let id, oc, os, dc, ds, eq, rate, pickup, posted, mc, mi;
    switch (board) {
      case 'dat': id = r.id; [oc, os] = splitPlace(r.origin); [dc, ds] = splitPlace(r.dest); eq = r.equip; rate = money(r.rate); pickup = r.pickup; posted = Date.parse(r.posted); mc = r.company.mc; mi = r.trip_mi; break;
      case 'truckstop': id = String(r.loadId); oc = r.originCity; os = r.originState; dc = r.destinationCity; ds = r.destinationState; eq = r.equipmentType; rate = money(r.paymentAmount); pickup = mdy(r.pickupDate, '/'); posted = r.postedAt; mc = r.broker.mcNumber.slice(2); mi = r.mileage; break;
      case 'portal_a': id = r.ref; oc = r.lane.from.city; os = r.lane.from.st; dc = r.lane.to.city; ds = r.lane.to.st; eq = r.mode; rate = money(r.price?.amount); pickup = r.pu.earliest.slice(0, 10); posted = Date.parse(r.created); mc = r.broker_mc; break;
      default: id = r.ref; [oc, os] = splitPlace(r.origin); [dc, ds] = splitPlace(r.destination); eq = r.equipment; rate = money(r.rate); pickup = mdy(r.pickup_date, '-'); posted = r.created_at * 1000; mc = r.mc;
    }
    const equipment = EQUIP[String(eq).toUpperCase()];
    if (!equipment) { counters.unknownEquip++; return null; }
    const o = lookup(oc, os), d = lookup(dc, ds);
    if (!o || !d) { counters.unknownPlace++; return null; }
    const m = mi ?? Math.round(miles(o.lat, o.lon, d.lat, d.lon) * 1.17);
    const contentHash = createHash('sha1').update(`${board}|${id}|${rate}|${pickup}|${o.city}|${d.city}|${equipment}`).digest('base64');
    return { key: `${board}:${id}`, board, brokerMc: mc, origin: { ...o, cell: geohash(o.lat, o.lon, 4) }, dest: { ...d, cell: geohash(d.lat, d.lon, 4) },
      equipment, rate, miles: m, pickupDate: pickup, postedAt: posted, contentHash };
  };
}

// ---------- dedup (LLD 6.6). Stage 2 uses a simple rule here; the trained classifier replaces it later ----------
type BlockEntry = { canonicalId: string; rate: number | null; brokerMc: string; postedAt: number };
export function makeDedup() {
  const seen = new Map<string, string>();
  const blocks = new Map<string, BlockEntry[]>();
  let next = 1;
  return (l: Load): { result: 'refresh' | 'updated' | 'merged' | 'new'; candidates: number } => {
    const prev = seen.get(l.key);
    if (prev === l.contentHash) return { result: 'refresh', candidates: 0 };
    seen.set(l.key, l.contentHash);
    if (prev) return { result: 'updated', candidates: 0 };
    let candidates = 0;
    for (const oc of neighbors4(l.origin.lat, l.origin.lon)) {
      const list = blocks.get(`${l.pickupDate}|${oc}|${l.dest.cell}|${l.equipment}`);
      if (!list) continue;
      for (const c of list) {
        candidates++;
        if (Math.abs(c.postedAt - l.postedAt) > 6 * 3_600_000) continue;
        if (c.rate !== null && l.rate !== null && Math.abs(c.rate - l.rate) / c.rate > 0.13) continue;
        l.canonicalId = c.canonicalId;
        return { result: 'merged', candidates };
      }
    }
    l.canonicalId = `C${next++}`;
    const k = `${l.pickupDate}|${l.origin.cell}|${l.dest.cell}|${l.equipment}`;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push({ canonicalId: l.canonicalId, rate: l.rate, brokerMc: l.brokerMc, postedAt: l.postedAt });
    return { result: 'new', candidates };
  };
}

// ---------- matcher (LLD 6.7): geohash level-3 index over saved searches ----------
export function loadMatcher(searchesFile: string) {
  const specs: Spec[] = [];
  for (const line of readFileSync(searchesFile, 'utf8').trim().split('\n')) {
    const u = JSON.parse(line);
    for (const s of u.searches) specs.push({ id: s.search_id, userId: u.user_id, lat: s.origin.lat, lon: s.origin.lon, deadhead: s.deadhead_mi, dest: s.dest, equipment: s.equipment, minRpm: s.min_rpm, days: s.pickup_within_days });
  }
  const index = new Map<string, Spec[]>();
  let entries = 0;
  for (const s of specs) {
    // every level-3 cell whose rectangle comes within the deadhead of the search origin
    const span = s.deadhead / 69 + L3.dlat, spanLon = s.deadhead / (69 * Math.cos(s.lat * R)) + L3.dlon;
    const cells = new Set<string>();
    for (let la = s.lat - span; la <= s.lat + span; la += L3.dlat / 2) for (let lo = s.lon - spanLon; lo <= s.lon + spanLon; lo += L3.dlon / 2) {
      const c = geohash(la, lo, 3);
      if (cells.has(c)) continue;
      const cLat0 = Math.floor((la + 90) / L3.dlat) * L3.dlat - 90, cLon0 = Math.floor((lo + 180) / L3.dlon) * L3.dlon - 180;
      const nLat = Math.min(Math.max(s.lat, cLat0), cLat0 + L3.dlat), nLon = Math.min(Math.max(s.lon, cLon0), cLon0 + L3.dlon);
      if (miles(s.lat, s.lon, nLat, nLon) <= s.deadhead) cells.add(c);
    }
    for (const c of cells) { const k = `${c}|${s.equipment}`; if (!index.has(k)) index.set(k, []); index.get(k)!.push(s); entries++; }
  }
  const dayMs = 86_400_000;
  const match = (l: Load) => {
    const cands = index.get(`${l.origin.cell.slice(0, 3)}|${l.equipment}`) ?? [];
    const users = new Map<string, string[]>();
    const pickup = Date.parse(l.pickupDate), today = Date.parse(new Date(l.postedAt - 6 * 3_600_000).toISOString().slice(0, 10));
    for (const s of cands) {
      if (miles(l.origin.lat, l.origin.lon, s.lat, s.lon) > s.deadhead) continue;
      if (s.dest.kind === 'states' && !s.dest.states.includes(l.dest.state)) continue;
      if (s.dest.kind === 'market' && miles(l.dest.lat, l.dest.lon, s.dest.lat, s.dest.lon) > s.dest.radius_mi) continue;
      if (l.rate !== null && s.minRpm !== null && l.rate / l.miles < s.minRpm) continue;   // no rate: included (LLD default)
      if ((pickup - today) / dayMs > s.days) continue;
      (users.get(s.userId) ?? users.set(s.userId, []).get(s.userId)!).push(s.id);
    }
    return { candidates: cands.length, users };
  };
  return { match, specs: specs.length, indexEntries: entries, cells: index.size };
}

// ---------- alerts (LLD 6.8): idempotency set + heap on postedAt ----------
export function makeAlerts() {
  const alerted = new Set<string>();
  const heap: number[] = [];
  const push = (v: number) => { heap.push(v); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p] <= heap[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < heap.length && heap[a] < heap[m]) m = a; if (b < heap.length && heap[b] < heap[m]) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  return {
    enqueue: (l: Load, users: Map<string, string[]>) => { let n = 0; for (const u of users.keys()) { const k = `${u}:${l.canonicalId}`; if (alerted.has(k)) continue; alerted.add(k); push(l.postedAt); n++; } return n; },
    drain: (max: number) => { let n = 0; while (heap.length && n < max) { pop(); n++; } return n; },
    size: () => heap.length,
  };
}
