// Synthetic load-board data for Load Radar load tests: writes a fixed dataset from the world model in
// sim/world.ts (calibrated to real market data, see ASSUMPTIONS.md; checked by validate.ts). Seeded: same flags, same files.
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

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, EQUIP_MIX, type Equip, type Load, type Posting, type Truth } from './world.ts';

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

const world = createWorld(SEED);
const postedAt = () => {
  const day = Math.floor(world.rand() * Math.max(1, HOURS / 24));
  const hour = HOURS < 24 ? Math.floor(world.rand() * HOURS) : world.pickHourOfDay();
  return START + day * 86_400_000 + hour * 3_600_000 + Math.floor(world.rand() * 3_600_000);
};

// ---------- loads ----------
const loads: Load[] = [];
while (loads.length < LOADS) { const l = world.makeLoad(postedAt()); loads.push(l, ...world.siblings(l)); }
if (BURST) {
  const [city, equip, offset, count, window] = BURST.split(':');
  if (!(equip in EQUIP_MIX)) throw new Error(`--burst: unknown equipment in ${BURST}`);
  const make = world.burstPicker(city, equip as Equip);
  for (let i = 0; i < Number(count); i++) loads.push(make(START + Number(offset) * 1000 + world.rand() * Number(window) * 1000));
}
const k = world.rateScale(loads);
for (const l of loads) world.finishRate(l, k);

// ---------- board postings ----------
const postings: Posting[] = [];
const truth: Truth[] = [];
for (const l of loads) { const r = world.postingsFor(l); postings.push(...r.postings); truth.push(r.truth); }
postings.sort((a, b) => a.posted_at - b.posted_at);

// ---------- users, credentials, saved searches ----------
const searches = Array.from({ length: USERS }, (_, i) => world.makeUser(i + 1));

// ---------- write ----------
mkdirSync(OUT, { recursive: true });
const ndjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(join(OUT, 'postings.ndjson'), ndjson(postings.map((p) => ({ board: p.board, posted_at: new Date(p.posted_at).toISOString(), raw: p.raw }))));
writeFileSync(join(OUT, 'truth.ndjson'), ndjson(truth));
writeFileSync(join(OUT, 'searches.ndjson'), ndjson(searches));
writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ seed: SEED, loads: loads.length, postings: postings.length, users: USERS, searches: world.searchCount(), hours: HOURS, start: new Date(START).toISOString(), burst: BURST ?? null, gravity_alpha: world.alphas }, null, 2) + '\n');
console.log(`${loads.length} loads, ${postings.length} postings, ${USERS} users, ${world.searchCount()} searches -> ${OUT}/ (gravity alpha ${JSON.stringify(world.alphas)})`);
