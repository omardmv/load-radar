// Eval cases for the load-decision agent: loads from the calibrated world model, a truck for each, and the policy's
// answer (src/agent/policy.ts). Balanced across verdicts, with comment traps ("NO TARP", "8FT TARPS", "-10F FROZEN").
//   node ml/agent/make_cases.ts --out ml/agent/cases.jsonl
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createWorld, type Equip } from '../../sim/world.ts';
import { decide, needsFrozen, needsTarps, type Facts, type Verdict } from '../../src/agent/policy.ts';

const { values: a } = parseArgs({ options: { out: { type: 'string', default: 'ml/agent/cases.jsonl' }, seed: { type: 'string', default: '21' }, 'per-verdict': { type: 'string', default: '6' } } });
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
const cases: { id: string; facts: Facts; expected: ReturnType<typeof decide>; traps: string[] }[] = [];
let traps = 0;
for (let i = 0; i < 200_000 && Object.values(want).some((n) => n > 0); i++) {
  const f = makeCase();
  const d = decide(f);
  const t = [needsTarps(f.load.comments) ? 'tarps' : '', /NO TARP/.test(f.load.comments) ? 'no-tarp' : '', needsFrozen(f.load.comments) ? 'frozen' : ''].filter(Boolean);
  if (want[d.verdict] <= 0) continue;
  if (!t.length && traps < per && r() < 0.8) continue;            // over-sample comment traps until we have a few
  if (t.length) traps++;
  want[d.verdict]--;
  cases.push({ id: `c${String(cases.length + 1).padStart(2, '0')}`, facts: f, expected: d, traps: t });
}
writeFileSync(a.out!, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
const count = (v: Verdict) => cases.filter((c) => c.expected.verdict === v).length;
console.log(JSON.stringify({ cases: cases.length, book: count('book'), negotiate: count('negotiate'), ask: count('ask'), skip: count('skip'), with_comment_traps: cases.filter((c) => c.traps.length).length }));
