// Eval cases for the load-decision agent: loads from the calibrated world model, a truck for each, and the policy's
// answer (src/agent/policy.ts). Balanced across verdicts, with comment traps ("NO TARP", "8FT TARPS", "-10F FROZEN").
//   node ml/agent/make_cases.ts --out ml/agent/cases.jsonl
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createWorld, type Equip } from '../../sim/world.ts';
import { decide, keywordRequirements, needsFrozen, needsTarps, type Facts, type Requirements, type Verdict } from '../../src/agent/policy.ts';

const { values: a } = parseArgs({ options: { out: { type: 'string', default: 'ml/agent/cases.jsonl' }, 'messy-out': { type: 'string', default: 'ml/agent/cases_messy.jsonl' }, seed: { type: 'string', default: '21' }, 'per-verdict': { type: 'string', default: '6' } } });
const world = createWorld(Number(a.seed));
const r = world.rand;
const start = Date.parse('2026-11-04T14:00:00Z');
const k = world.rateScale(Array.from({ length: 4000 }, () => world.makeLoad(start)));
const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];

function makeCase(): Facts {
  const l = world.makeLoad(start + Math.floor(r() * 3_600_000));
  world.finishRate(l, k);
  const market = world.expectedRpm(l.om.city, l.equip, l.miles, k);
  const maxDh = pick([50, 100, 150]);
  return {
    load: { load_id: l.load_id, origin: `${l.o.name}, ${l.o.state}`, origin_market: l.om.city, dest: `${l.d.name}, ${l.d.state}`, equipment: l.equip,
      equipment_detail: l.detail, rate: l.rate, miles: l.miles, weight_lbs: l.weight, pickup_date: l.pickup, comments: l.comment, broker: l.broker.name, board: 'dat' },
    truck: { location: `${l.o.name} area`, lat: l.o.lat, lon: l.o.lon, equipment: l.equip as Equip, has_tarps: r() < 0.5, frozen_capable: l.equip === 'reefer' ? r() < 0.5 : false,
      max_weight_lbs: pick([40_000, 45_000, 48_000]), max_deadhead_mi: maxDh,
      min_rate_per_mile: r() < 0.5 ? null : Math.round(market * (0.9 + 0.3 * r()) * 100) / 100 },
    market_rate_per_mile: market,
    deadhead_miles: Math.round(r() < 0.8 ? maxDh * r() : maxDh * (1.05 + r())),
  };
}

const per = Number(a['per-verdict']);
const want: Record<Verdict, number> = { book: per, negotiate: per, ask: per, skip: per };
const cases: { id: string; facts: Facts; expected: ReturnType<typeof decide>; traps: string[]; requirements: Requirements }[] = [];
let traps = 0;
for (let i = 0; i < 200_000 && Object.values(want).some((n) => n > 0); i++) {
  const f = makeCase();
  const d = decide(f);
  const t = [needsTarps(f.load.comments) ? 'tarps' : '', /NO TARP/.test(f.load.comments) ? 'no-tarp' : '', needsFrozen(f.load.comments) ? 'frozen' : ''].filter(Boolean);
  if (want[d.verdict] <= 0) continue;
  if (!t.length && traps < per && r() < 0.8) continue;            // over-sample comment traps until we have a few
  if (t.length) traps++;
  want[d.verdict]--;
  cases.push({ id: `c${String(cases.length + 1).padStart(2, '0')}`, facts: f, expected: d, traps: t, requirements: keywordRequirements(f.load.comments) });
}
writeFileSync(a.out!, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
const count = (v: Verdict) => cases.filter((c) => c.expected.verdict === v).length;
console.log(JSON.stringify({ cases: cases.length, book: count('book'), negotiate: count('negotiate'), ask: count('ask'), skip: count('skip'), with_comment_traps: cases.filter((c) => c.traps.length).length }));

// Messy set: real-world wording the keyword rule wasn't written for, hand-labeled (messy_comments.json). Each phrase goes
// on a load of the right equipment whose truck has no tarps and isn't frozen-capable, with the rate at market and the
// deadhead in range, so reading the comment correctly is what decides the verdict (skip vs book).
const messy: { equipment: Equip; comments: string; needs_tarps: boolean; needs_frozen: boolean }[] = JSON.parse(readFileSync(new URL('./messy_comments.json', import.meta.url), 'utf8'));
const messyCases = messy.map((m, i) => {
  let f = makeCase();
  while (f.load.equipment !== m.equipment) f = makeCase();
  f.load.comments = m.comments;
  if (f.load.rate === null) f.load.rate = Math.round((f.market_rate_per_mile * f.load.miles * 1.05) / 25) * 25;
  f.load.rate = Math.max(f.load.rate, Math.ceil((f.market_rate_per_mile * f.load.miles) / 25) * 25);
  f.load.weight_lbs = Math.min(f.load.weight_lbs, 40_000);
  f.truck = { ...f.truck, has_tarps: false, frozen_capable: false, min_rate_per_mile: null, max_weight_lbs: 45_000 };
  f.deadhead_miles = Math.min(f.deadhead_miles, f.truck.max_deadhead_mi - 5);
  const req = { needs_tarps: m.needs_tarps, needs_frozen: m.needs_frozen };
  return { id: `m${String(i + 1).padStart(2, '0')}`, facts: f, expected: decide(f, req), traps: ['messy'], requirements: req,
    keyword_reads_it_right: JSON.stringify(keywordRequirements(m.comments)) === JSON.stringify(req) };
});
writeFileSync(a['messy-out']!, messyCases.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(JSON.stringify({ messy_cases: messyCases.length, skip: messyCases.filter((c) => c.expected.verdict === 'skip').length, keyword_rule_reads_right: messyCases.filter((c) => c.keyword_reads_it_right).length }));
