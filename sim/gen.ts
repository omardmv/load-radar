// Synthetic load-board data for Load Radar load tests, calibrated to real market data (see ASSUMPTIONS.md,
// checked by validate.ts). Seeded and deterministic: same flags, same files. No dependencies.
//
//   node sim/gen.ts --loads 100000 --users 5000 --hours 24 --seed 1 --out out/
//   node sim/gen.ts --loads 20000 --burst Chicago:van:3600:2000:120   # +2000 Chicago vans over 120s, 1h in
//   node sim/validate.ts out/
//
// --loads counts real loads. Each one becomes ~3 board postings (reposts, cross-posts, co-brokers), the way a
// real board's "load posts" count does: DAT's ~500K posts a day is roughly --loads 170000 --hours 24.
//
// Writes:
//   postings.ndjson  every posting, sorted by posted_at, in its board's own format (what pollers see)
//   truth.ndjson     one line per real load and every posting that carries it (the answer key)
//   searches.ndjson  users, their board credentials and saved searches, with a natural-language phrasing

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Market = { city: string; state: string; lat: number; lon: number; pop: number; heat: number; reefer?: boolean };
type Town = { name: string; state: string; lat: number; lon: number; pop: number; market: string };
type Broker = { mc: string; name: string; city: string; state: string };
type Equip = 'van' | 'reefer' | 'flatbed';
type Board = 'dat' | 'truckstop' | 'portal_a' | 'portal_b';
type Kind = 'first' | 'refresh' | 'repost' | 'cross_board' | 'co_broker';

// ---------- flags ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);
const LOADS = Number(args.loads ?? 50_000);
const USERS = Number(args.users ?? 2_000);
const HOURS = Number(args.hours ?? 24);
const SEED = Number(args.seed ?? 1);
const START = Date.parse(args.start ?? '2026-11-04T06:00:00Z'); // midnight US Central (CST)
const OUT = args.out ?? 'out';
const BURST = args.burst; // market:equip:offsetSeconds:count:windowSeconds

// ---------- seeded randomness ----------
let s = SEED >>> 0 || 1;
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const lognormal = (median: number, sigma: number) => median * Math.exp(sigma * normal());
const uniform = (a: number, b: number) => a + (b - a) * rand();
const int = (a: number, b: number) => Math.floor(uniform(a, b + 1));
const chance = (p: number) => rand() < p;
const pickOne = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
function sampler<T>(items: readonly T[], weights: readonly number[]) {
  const cum: number[] = []; let total = 0;
  for (const w of weights) cum.push((total += w));
  return () => { const x = rand() * total; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } return items[lo]; };
}
const weighted = <K extends string | number>(table: Record<K, number>) => sampler(Object.keys(table) as K[], Object.values(table) as number[]);

// ---------- reference data ----------
const here = dirname(fileURLToPath(import.meta.url));
const markets: Market[] = JSON.parse(readFileSync(join(here, 'data/markets.json'), 'utf8')).markets;
const towns: Town[] = JSON.parse(readFileSync(join(here, 'data/towns.json'), 'utf8')).towns;
const brokers: Broker[] = JSON.parse(readFileSync(join(here, 'data/brokers.json'), 'utf8'));

// ---------- calibration targets (sources in ASSUMPTIONS.md) ----------
const BASE_RPM: Record<Equip, number> = { van: 3.06, reefer: 3.61, flatbed: 3.62 }; // DAT, with fuel, hauls >= 250 mi
const EQUIP_MIX: Record<Equip, number> = { van: 0.41, reefer: 0.18, flatbed: 0.41 }; // DAT weekly load posts, 2026
const TARGET_MILES: Record<Equip, number> = { van: 480, reefer: 600, flatbed: 360 }; // DAT length of haul + SONAR 2025
const NO_RATE = 0.29; // public board sample, n=400
const PICKUP_DAYS = weighted({ 0: 0.51, 1: 0.32, 2: 0.13, 3: 0.02, 4: 0.01, 7: 0.01 }); // same sample
const CROSS_BOARD = 0.3, CO_BROKER = 0.08, SIBLINGS = 0.1, REPOST_P = 0.5;

// ---------- geography ----------
const toRad = (d: number) => (d * Math.PI) / 180;
type Point = { lat: number; lon: number };
const roadMiles = (a: Point, b: Point) => {
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
  return Math.round(3958.8 * 2 * Math.asin(Math.sqrt(h)) * 1.17); // great-circle × road circuity
};
const marketByCity = new Map(markets.map((m) => [m.city, m]));
// A load starts at the metro itself 35% of the time, otherwise a nearby town (bigger towns more often).
const townPickers = new Map(markets.map((m) => {
  const local = towns.filter((t) => t.market === m.city);
  return [m.city, sampler(local, local.map((t) => Math.sqrt(t.pop)))];
}));
const pickTown = (m: Market): Town => chance(0.35) ? { name: m.city, state: m.state, lat: m.lat, lon: m.lon, pop: m.pop * 1e6, market: m.city } : townPickers.get(m.city)!();
const marketRateFactor = new Map(markets.map((m) => [m.city, Math.exp(0.06 * normal()) * (0.94 + 0.06 * m.heat)]));

// ---------- lanes: gravity model, distance decay calibrated per equipment ----------
// weight = outbound pull × inbound pull / miles^alpha. alpha is solved so the expected trip length hits
// TARGET_MILES for each equipment type. Same-market lanes (town to town inside a region) are allowed.
type Lane = { o: Market; d: Market; miles: number };
const lanes: Lane[] = [];
for (const o of markets) for (const d of markets) lanes.push({ o, d, miles: o === d ? 110 : roadMiles(o, d) });
const pull = (m: Market) => m.pop ** 0.6;
const outPull = (m: Market, e: Equip) => pull(m) * m.heat * (e === 'reefer' ? (m.reefer ? 3 : 0.8) : 1);
const laneWeights = (e: Equip, alpha: number) => lanes.map((l) => outPull(l.o, e) * pull(l.d) * (l.o === l.d ? 0.1 : 1) / l.miles ** alpha);
const meanMiles = (w: number[]) => w.reduce((sum, x, i) => sum + x * lanes[i].miles, 0) / w.reduce((a, b) => a + b, 0);
const lanePickers = {} as Record<Equip, () => Lane>;
const alphas = {} as Record<Equip, number>;
for (const e of Object.keys(EQUIP_MIX) as Equip[]) {
  let lo = 0, hi = 5;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (meanMiles(laneWeights(e, mid)) > TARGET_MILES[e]) lo = mid; else hi = mid; }
  alphas[e] = +((lo + hi) / 2).toFixed(3);
  lanePickers[e] = sampler(lanes, laneWeights(e, alphas[e]));
}
const pickEquip = weighted(EQUIP_MIX);

// Big brokers post far more than small ones: Zipf over a shuffled broker list.
const brokerOrder = [...brokers].sort(() => rand() - 0.5);
const pickBroker = sampler(brokerOrder, brokerOrder.map((_, i) => 1 / (i + 1) ** 1.1));

// Postings per hour of the US Central day: busy 7:00–12:00, quiet overnight.
const HOURLY = [0.3, 0.2, 0.2, 0.2, 0.4, 0.8, 1.5, 2.4, 2.8, 2.9, 2.7, 2.3, 1.9, 2.0, 2.1, 1.9, 1.6, 1.2, 0.9, 0.7, 0.6, 0.5, 0.4, 0.3];
const pickHourOfDay = sampler(HOURLY.map((_, h) => h), HOURLY);
const postedAt = () => {
  const day = Math.floor(rand() * Math.max(1, HOURS / 24));
  const hour = HOURS < 24 ? Math.floor(rand() * HOURS) : pickHourOfDay();
  return START + day * 86_400_000 + hour * 3_600_000 + Math.floor(rand() * 3_600_000);
};
const centralDate = (ms: number) => new Date(ms - 6 * 3_600_000).toISOString().slice(0, 10);

// ---------- loads ----------
const EQUIP_DETAIL: Record<Equip, () => string> = {
  van: weighted({ 'Van': 0.85, 'Van/Reefer': 0.15 }),
  reefer: weighted({ 'Reefer': 1 }),
  flatbed: weighted({ 'Flatbed': 0.6, 'Flatbed/Step Deck': 0.25, 'Step Deck': 0.08, 'Flatbed (w/Tarps)': 0.07 }),
};
const COMMENTS: Record<Equip, string[]> = {
  van: ['NO TOUCH', 'DROP AND HOOK', 'LUMPER AT DEL', 'FCFS PICKUP', 'APPT REQUIRED', 'BEVERAGE', 'PAPER PRODUCTS', 'LOAD BARS REQ'],
  reefer: ['34F CONTINUOUS', '-10F FROZEN', 'PRODUCE 36F PULP REQ', 'FSMA COMPLIANT', 'MEAT 28F', 'DAIRY 35F'],
  flatbed: ['TARPS REQUIRED', '6FT TARPS', '8FT TARPS', 'NO TARP', 'STRAPS AND CHAINS', 'LUMBER', 'STEEL COILS CHAINS REQ', 'BUILDING MATERIALS'],
};
const PAY = ['QUICK PAY 2%', 'PAY IN 3 TO 5 DAYS NO FEE', 'NET 30', 'FACTORING OK', '', '', ''];
type Load = {
  load_id: string; broker: Broker; o: Town; d: Town; om: Market; dm: Market; miles: number; equip: Equip; detail: string;
  rate: number | null; weight: number; pickup: string; posted_at: number; comment: string; sibling_of: string | null;
};
const WEIGHT: Record<Equip, [number, number]> = { van: [12_000, 44_000], reefer: [18_000, 43_000], flatbed: [20_000, 48_000] };
let nextId = 1;
function makeLoad(e: Equip, lane: Lane, at: number): Load {
  let o = pickTown(lane.o), d = pickTown(lane.d), miles = roadMiles(o, d);
  for (let i = 0; i < 5 && miles < 30; i++) { d = pickTown(lane.d); miles = roadMiles(o, d); }
  miles = Math.max(miles, 30);
  const rpm = BASE_RPM[e] * marketRateFactor.get(lane.o.city)! * (1 + 0.5 * Math.exp(-miles / 400)) * lognormal(1, 0.1);
  return {
    load_id: `L${String(nextId++).padStart(8, '0')}`, broker: pickBroker(), o, d, om: lane.o, dm: lane.d, miles, equip: e,
    detail: EQUIP_DETAIL[e](), rate: Math.round((rpm * miles) / 25) * 25, weight: Math.round(uniform(...WEIGHT[e]) / 1000) * 1000,
    pickup: centralDate(at + Number(PICKUP_DAYS()) * 86_400_000), posted_at: at,
    comment: [pickOne(COMMENTS[e]), pickOne(PAY)].filter(Boolean).join(' / '), sibling_of: null,
  };
}
const loads: Load[] = [];
const addLoad = (l: Load) => {
  loads.push(l);
  // Recurring freight: the same lane posted again for the next pickup days. Separate real loads, not duplicates.
  if (chance(SIBLINGS)) for (let k = 1; k <= int(1, 2); k++) {
    const next = new Date(Date.parse(l.pickup) + k * 86_400_000).toISOString().slice(0, 10);
    loads.push({ ...l, load_id: `L${String(nextId++).padStart(8, '0')}`, pickup: next, posted_at: l.posted_at + int(0, 120_000), sibling_of: l.load_id });
  }
};
while (loads.length < LOADS) { const e = pickEquip(); addLoad(makeLoad(e, lanePickers[e](), postedAt())); }
if (BURST) {
  const [city, equip, offset, count, window] = BURST.split(':');
  const o = markets.find((m) => m.city.toLowerCase() === city.toLowerCase());
  if (!o || !(equip in EQUIP_MIX)) throw new Error(`--burst: unknown market or equipment in ${BURST}`);
  const e = equip as Equip;
  const fromHere = lanes.map((l, i) => [l, laneWeights(e, alphas[e])[i]] as const).filter(([l]) => l.o === o);
  const pickFromHere = sampler(fromHere.map(([l]) => l), fromHere.map(([, w]) => w));
  for (let i = 0; i < Number(count); i++) loads.push(makeLoad(e, pickFromHere(), START + Number(offset) * 1000 + rand() * Number(window) * 1000));
}
// Rates: some loads have none; the rest are scaled so the mean $/mi of hauls >= 250 mi matches DAT exactly.
for (const l of loads) if (chance(NO_RATE)) l.rate = null;
for (const e of Object.keys(BASE_RPM) as Equip[]) {
  const ref = loads.filter((l) => l.equip === e && l.rate !== null && l.miles >= 250);
  const k = BASE_RPM[e] / (ref.reduce((sum, l) => sum + l.rate! / l.miles, 0) / ref.length);
  for (const l of loads) if (l.equip === e && l.rate !== null) l.rate = Math.max(300, Math.round((l.rate * k) / 25) * 25); // short-haul minimum
}

// ---------- board postings ----------
const BOARD_SHARE: Record<Board, number> = { dat: 0.5, truckstop: 0.3, portal_a: 0.12, portal_b: 0.08 };
const BOARDS = Object.keys(BOARD_SHARE) as Board[];
const pickBoard = weighted(BOARD_SHARE);
const SPELLINGS: Record<string, string[]> = {
  'St. Louis': ['St. Louis', 'St Louis', 'Saint Louis'], 'Ontario': ['Ontario', 'Ontario (Inland Empire)'],
  'Los Angeles': ['Los Angeles', 'LA', 'Vernon'], 'Kansas City': ['Kansas City', 'Kansas Cty'], 'Fort Worth': ['Fort Worth', 'Ft Worth', 'FT. WORTH'],
};
const spell = (t: Town) => {
  let n = chance(0.25) && SPELLINGS[t.name] ? pickOne(SPELLINGS[t.name]) : t.name;
  if (chance(0.15)) n = n.replace(/^Saint /, 'St ').replace(/^Fort /, 'Ft ').replace(/^Mount /, 'Mt ');
  return n;
};
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const money = (n: number) => `$${n.toLocaleString('en-US')}.00`;

function render(board: Board, l: Load, broker: Broker, at: number, rate: number | null, id: string) {
  switch (board) {
    case 'dat': return {
      id, origin: `${spell(l.o)}, ${l.o.state}`, dest: `${spell(l.d)}, ${l.d.state}`,
      equip: { van: l.detail === 'Van' ? 'V' : 'VR', reefer: 'R', flatbed: l.detail.includes('Step') ? 'FD' : 'F' }[l.equip],
      rate, trip_mi: l.miles, weight_lbs: l.weight, pickup: l.pickup, posted: new Date(at).toISOString(),
      comments: l.comment, company: { name: broker.name, mc: broker.mc },
    };
    case 'truckstop': return { // fixed-width legacy fields: city names cut at 14 characters
      loadId: Number(id), originCity: spell(l.o).toUpperCase().slice(0, 14), originState: l.o.state,
      destinationCity: spell(l.d).toUpperCase().slice(0, 14), destinationState: l.d.state, equipmentType: l.detail.toUpperCase(),
      paymentAmount: rate === null ? '$0' : money(rate), mileage: l.miles + int(-6, 6), weight: `${l.weight.toLocaleString('en-US')} lbs`,
      pickupDate: `${l.pickup.slice(5, 7)}/${l.pickup.slice(8, 10)}/${l.pickup.slice(0, 4)}`, postedAt: at, specInfo: l.comment,
      broker: { companyName: broker.name.toUpperCase(), mcNumber: `MC${broker.mc}` },
    };
    case 'portal_a': return {
      ref: id, lane: { from: { city: spell(l.o), st: l.o.state }, to: { city: spell(l.d), st: l.d.state } },
      mode: { van: "Dry Van 53'", reefer: "Reefer 53'", flatbed: l.detail.includes('Step') ? "Step Deck 48'" : "Flatbed 48'" }[l.equip],
      price: rate === null ? null : { amount: rate, currency: 'USD' },
      pu: { earliest: `${l.pickup}T06:00:00-06:00`, latest: `${l.pickup}T18:00:00-06:00` },
      created: new Date(at).toISOString(), notes: l.comment, broker_mc: broker.mc,
    };
    case 'portal_b': return { // weight in thousands but labeled lbs, as seen on a real public board
      ref: id, pickup_date: `${l.pickup.slice(5, 7)}-${l.pickup.slice(8, 10)}-${l.pickup.slice(0, 4)}`,
      origin: `${spell(l.o).toUpperCase()}, ${l.o.state}`, destination: `${spell(l.d).toUpperCase()}, ${l.d.state}`,
      equipment: l.detail, rate: rate === null ? '$0' : `$${rate.toLocaleString('en-US')}`, weight: `${(l.weight / 1000).toFixed(2)} lbs`,
      size: 'Full', company: broker.name, mc: broker.mc, details: l.comment, created_at: Math.floor(at / 1000),
    };
  }
}
const newId = (board: Board) => board === 'dat' ? `DAT-${hex(10)}` : board === 'truckstop' ? String(int(10_000_000, 99_999_999)) : `${board === 'portal_a' ? 'PA' : 'PB'}${int(100_000, 999_999)}`;

type Posting = { board: Board; posted_at: number; raw: ReturnType<typeof render> };
const postings: Posting[] = [];
const truth: object[] = [];
for (const l of loads) {
  const carried: object[] = [];
  // One "listing" = a broker posting this load on a board. The listing is refreshed or reposted over time.
  const list = (board: Board, broker: Broker, at: number, rate: number | null, kind: Kind) => {
    let id = newId(board), t = at, k: Kind = kind;
    for (;;) {
      postings.push({ board, posted_at: t, raw: render(board, l, broker, t, rate, id) });
      carried.push({ board, board_load_id: id, broker_mc: broker.mc, posted_at: new Date(t).toISOString(), rate, kind: k });
      if (!chance(REPOST_P)) break;
      t += Math.round(lognormal(30, 0.6) * 60_000); // refresh/repost ~every 30 min
      if (chance(0.5)) { id = newId(board); k = 'repost'; } else k = 'refresh'; // repost = deleted and posted again, new id
    }
  };
  const first = pickBoard();
  list(first, l.broker, l.posted_at, l.rate, 'first');
  if (chance(CROSS_BOARD)) for (const b of BOARDS) if (b !== first && chance(0.4)) {
    const r = l.rate === null ? null : chance(0.3) ? l.rate + pickOne([-50, -25, 25, 50]) : chance(0.1) ? null : l.rate;
    list(b, l.broker, l.posted_at + Math.round(lognormal(90, 0.8) * 1000), r, 'cross_board');
  }
  if (chance(CO_BROKER)) { // a second broker re-posts the same load, keeping a 5–12% margin
    let other = pickBroker(); while (other.mc === l.broker.mc) other = pickBroker();
    list(pickBoard(), other, l.posted_at + Math.round(lognormal(10, 0.7) * 60_000), l.rate === null ? null : Math.round((l.rate * uniform(0.88, 0.95)) / 25) * 25, 'co_broker');
  }
  truth.push({
    load_id: l.load_id, sibling_of: l.sibling_of, broker_mc: l.broker.mc,
    origin: { city: l.o.name, state: l.o.state, lat: l.o.lat, lon: l.o.lon, market: l.om.city },
    dest: { city: l.d.name, state: l.d.state, lat: l.d.lat, lon: l.d.lon, market: l.dm.city },
    equipment: l.equip, equipment_detail: l.detail, miles: l.miles, rate: l.rate, weight_lbs: l.weight, pickup_date: l.pickup,
    first_posted_at: new Date(l.posted_at).toISOString(), postings: carried,
  });
}
postings.sort((a, b) => a.posted_at - b.posted_at);

// ---------- users, credentials, saved searches ----------
const pickHome = sampler(markets, markets.map((m) => (pull(m) * m.heat) ** 0.8));
const STATES = [...new Set(markets.map((m) => m.state))];
const searches: object[] = [];
let searchCount = 0;
for (let u = 1; u <= USERS; u++) {
  const home = pickHome();
  const creds = BOARDS.filter((b) => chance({ dat: 0.85, truckstop: 0.5, portal_a: 0.25, portal_b: 0.15 }[b]));
  if (creds.length === 0) creds.push('dat');
  const n = Math.max(1, Math.round(lognormal(3.5, 0.5)));
  const user = { user_id: `U${String(u).padStart(6, '0')}`, home: home.city, credentials: creds.map((b) => ({ board: b, credential_id: `${b}-${hex(8)}` })), searches: [] as object[] };
  for (let k = 0; k < n; k++) {
    const m = chance(0.75) ? home : pickHome();
    const at = chance(0.6) ? { name: m.city, state: m.state, lat: m.lat, lon: m.lon } : pickTown(m); // where the empty truck is
    const equip = pickEquip();
    const radius = pickOne([50, 75, 100, 150]);
    const destKind = rand();
    const dest = destKind < 0.5 ? { kind: 'anywhere' as const }
      : destKind < 0.8 ? { kind: 'states' as const, states: [...new Set(Array.from({ length: int(1, 3) }, () => pickOne(STATES)))] }
      : (() => { const dm = pickHome(); return { kind: 'market' as const, city: dm.city, state: dm.state, lat: dm.lat, lon: dm.lon, radius_mi: pickOne([100, 150, 200]) }; })();
    const minRpm = chance(0.3) ? null : Math.round(BASE_RPM[equip] * uniform(0.85, 1.15) * 100) / 100;
    const destText = dest.kind === 'anywhere' ? 'anywhere' : dest.kind === 'states' ? dest.states.join('/') : `${dest.city}, ${dest.state} (within ${dest.radius_mi} mi)`;
    const phrasing = pickOne([
      `${at.name}, ${at.state} to ${destText}, ${equip} only, under ${radius} mi deadhead${minRpm ? `, min $${minRpm.toFixed(2)}/mi` : ''}`,
      `need ${equip} out of ${at.name} going ${destText}${minRpm ? ` paying at least ${minRpm.toFixed(2)} a mile` : ''}, ${radius} mile radius`,
      `${equip.toUpperCase()} ${at.name.toUpperCase()} ${at.state} -> ${destText.toUpperCase()} DH ${radius}${minRpm ? ` RPM ${minRpm}` : ''}`,
    ]);
    user.searches.push({
      search_id: `S${String(++searchCount).padStart(7, '0')}`, origin: { city: at.name, state: at.state, lat: at.lat, lon: at.lon },
      deadhead_mi: radius, dest, equipment: equip, min_rpm: minRpm, pickup_within_days: int(0, 3), text: phrasing,
    });
  }
  searches.push(user);
}

// ---------- write ----------
mkdirSync(OUT, { recursive: true });
const ndjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(join(OUT, 'postings.ndjson'), ndjson(postings.map((p) => ({ board: p.board, posted_at: new Date(p.posted_at).toISOString(), raw: p.raw }))));
writeFileSync(join(OUT, 'truth.ndjson'), ndjson(truth));
writeFileSync(join(OUT, 'searches.ndjson'), ndjson(searches));
writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ seed: SEED, loads: loads.length, postings: postings.length, users: USERS, searches: searchCount, hours: HOURS, start: new Date(START).toISOString(), burst: BURST ?? null, gravity_alpha: alphas }, null, 2) + '\n');
console.log(`${loads.length} loads, ${postings.length} postings, ${USERS} users, ${searchCount} searches -> ${OUT}/ (gravity alpha ${JSON.stringify(alphas)})`);
