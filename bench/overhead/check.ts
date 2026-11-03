// Sanity check for core.ts against the generator's answer key. Not part of the benchmark.
//   node bench/overhead/check.ts /tmp/lr/v6
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGazetteer, makeNormalizer, makeDedup, loadMatcher, makeAlerts, type Counters } from './core.ts';

const dir = process.argv[2] ?? 'out';
const here = dirname(fileURLToPath(import.meta.url));
const counters: Counters = { unknownPlace: 0, unknownEquip: 0 };
const normalize = makeNormalizer(loadGazetteer(join(here, '../../sim/data')), counters);
const dedup = makeDedup();
let t = Date.now();
const m = loadMatcher(join(dir, 'searches.ndjson'));
console.log(`matcher: ${m.specs} searches, ${m.indexEntries} index entries (${(m.indexEntries / m.specs).toFixed(1)} cells/search), ${m.cells} keys, built in ${Date.now() - t} ms`);
const alerts = makeAlerts();

// answer key: board posting id -> real load id
const truthOf = new Map<string, string>();
let realLoads = 0;
for (const line of readFileSync(join(dir, 'truth.ndjson'), 'utf8').trim().split('\n')) {
  const l = JSON.parse(line); realLoads++;
  for (const p of l.postings) truthOf.set(`${p.board}:${p.board_load_id}`, l.load_id);
}
const results: Record<string, number> = {};
const canonToReal = new Map<string, Set<string>>();
let n = 0, fanout = 0, matchedUsers = 0, alertsMade = 0;
t = Date.now();
for (const line of readFileSync(join(dir, 'postings.ndjson'), 'utf8').trim().split('\n')) {
  const p = JSON.parse(line); n++;
  const l = normalize(p.board, p.raw); if (!l) continue;
  const d = dedup(l); results[d.result] = (results[d.result] ?? 0) + 1;
  if (d.result === 'refresh' || d.result === 'updated') continue;
  const real = truthOf.get(l.key)!;
  (canonToReal.get(l.canonicalId!) ?? canonToReal.set(l.canonicalId!, new Set()).get(l.canonicalId!)!).add(real);
  const r = m.match(l); fanout += r.candidates; matchedUsers += r.users.size; alertsMade += alerts.enqueue(l, r.users);
}
const ms = Date.now() - t;
const canon = canonToReal.size;
const wrongMerges = [...canonToReal.values()].filter((s) => s.size > 1).length;
const realSeen = new Set([...canonToReal.values()].flatMap((s) => [...s]));
console.log(`${n} postings in ${ms} ms (${Math.round(n / ms * 1000)}/s single thread, incl. JSON.parse)`);
console.log(`normalize drops: ${counters.unknownPlace} unknown place, ${counters.unknownEquip} unknown equipment`);
console.log(`dedup: ${JSON.stringify(results)}`);
console.log(`canonical loads ${canon} vs real loads ${realLoads} (${realSeen.size} distinct real loads seen); canonicals that merged different real loads: ${wrongMerges} (${(100 * wrongMerges / canon).toFixed(2)}%)`);
console.log(`matcher: avg ${(fanout / canon).toFixed(0)} candidates per new load, ${(matchedUsers / canon).toFixed(1)} users matched per load; ${alertsMade} alerts`);
