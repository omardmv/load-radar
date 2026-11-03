// Checks generated data against real-world reference numbers. Exit code 1 if any check fails.
//   node sim/validate.ts out/
// Computed from truth.ndjson only (not from the generator's own bookkeeping), so a generator bug shows up here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type P = { board: string; board_load_id: string; broker_mc: string; posted_at: string; rate: number | null; kind: string };
type L = {
  load_id: string; sibling_of: string | null; broker_mc: string; equipment: 'van' | 'reefer' | 'flatbed'; miles: number; rate: number | null;
  pickup_date: string; first_posted_at: string; origin: { city: string; state: string }; dest: { city: string; state: string }; postings: P[];
};

const dir = process.argv[2] ?? 'out';
const loads: L[] = readFileSync(join(dir, 'truth.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const posts = loads.flatMap((l) => l.postings.map((p) => ({ ...p, l })));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const share = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length / xs.length;
const centralDate = (iso: string) => new Date(Date.parse(iso) - 6 * 3_600_000).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const rpm = (l: L) => l.rate! / l.miles;
const rated = (e: string, f: (l: L) => boolean = () => true) => loads.filter((l) => l.equipment === e && l.rate !== null && f(l));

// Exact duplicate rows the way a person scanning a board sees them: same board, lane, equipment, rate, pickup date.
const seen = new Set<string>();
let dupRows = 0;
for (const p of [...posts].sort((a, b) => a.posted_at.localeCompare(b.posted_at))) {
  const key = [p.board, p.l.origin.city, p.l.origin.state, p.l.dest.city, p.l.dest.state, p.l.equipment, p.rate, p.l.pickup_date].join('|');
  if (seen.has(key)) dupRows++; else seen.add(key);
}
// "Lanes posted by 2+ companies" grows with sample size, so measure it like the reference: one board's
// postings, on a board-sized sample (~6,000 postings), taking whole loads.
const BOARD_SIZE = 6_000;
const datPerLoad = posts.filter((p) => p.board === 'dat').length / loads.length;
const keep = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 1_000_000 < (BOARD_SIZE / datPerLoad / loads.length) * 1_000_000;
const laneBrokers = new Map<string, Set<string>>();
for (const p of posts.filter((p) => p.board === 'dat' && keep(p.l.load_id))) {
  const k = [p.l.origin.city, p.l.origin.state, p.l.dest.city, p.l.dest.state, p.l.equipment].join('|');
  if (!laneBrokers.has(k)) laneBrokers.set(k, new Set());
  laneBrokers.get(k)!.add(p.broker_mc);
}
const perMinute = new Map<number, number>();
for (const p of posts) { const m = Math.floor(Date.parse(p.posted_at) / 60_000); perMinute.set(m, (perMinute.get(m) ?? 0) + 1); }
const minutes = [...perMinute.values()];
const firstLoads = loads.filter((l) => !l.sibling_of);

const DAT = 'DAT weekly load posts, 2026 (Mar–May)';
const HAUL = 'DAT length of haul (van 439, reefer 610, flatbed ~330) + SONAR 2025 all-TL 522–571';
const RPM = 'DAT Trendlines week of 2026-10-19, with fuel, hauls >= 250 mi';
const BOARD = 'public load board sample, n=400 rows, 2026-11-03 (small, flatbed-heavy board: low confidence)';
const checks: [string, number, number, number | null, string][] = [
  // name, value, target, tolerance (±; null = reported only, no trustworthy reference), source
  ['postings share: van', share(posts, (p) => p.l.equipment === 'van'), 0.41, 0.05, DAT],
  ['postings share: reefer', share(posts, (p) => p.l.equipment === 'reefer'), 0.18, 0.04, DAT],
  ['postings share: flatbed', share(posts, (p) => p.l.equipment === 'flatbed'), 0.41, 0.05, DAT],
  ['mean miles: van', mean(loads.filter((l) => l.equipment === 'van').map((l) => l.miles)), 480, 70, HAUL],
  ['mean miles: reefer', mean(loads.filter((l) => l.equipment === 'reefer').map((l) => l.miles)), 600, 80, HAUL],
  ['mean miles: flatbed', mean(loads.filter((l) => l.equipment === 'flatbed').map((l) => l.miles)), 360, 70, HAUL],
  ['$/mi >= 250 mi: van', mean(rated('van', (l) => l.miles >= 250).map(rpm)), 3.06, 0.03, RPM],
  ['$/mi >= 250 mi: reefer', mean(rated('reefer', (l) => l.miles >= 250).map(rpm)), 3.61, 0.03, RPM],
  ['$/mi >= 250 mi: flatbed', mean(rated('flatbed', (l) => l.miles >= 250).map(rpm)), 3.62, 0.03, RPM],
  ['van $/mi: <500 mi ÷ 1000–2000 mi', mean(rated('van', (l) => l.miles < 500).map(rpm)) / mean(rated('van', (l) => l.miles >= 1000 && l.miles <= 2000).map(rpm)), 1.42, 0.15, 'Nuvocargo 2026 dry van guide: $3.20 vs $2.25 market (broker guide: low confidence)'],
  ['postings with no rate', share(posts, (p) => p.rate === null), 0.29, 0.06, BOARD],
  ['pickup same day', share(firstLoads, (l) => days(centralDate(l.first_posted_at), l.pickup_date) === 0), 0.51, 0.08, BOARD],
  ['pickup next day', share(firstLoads, (l) => days(centralDate(l.first_posted_at), l.pickup_date) === 1), 0.32, 0.08, BOARD],
  ['exact duplicate rows', dupRows / posts.length, 0.54, 0.14, BOARD],
  ['lanes posted by 2+ companies', share([...laneBrokers.values()], (s) => s.size > 1), 0.08, 0.05, BOARD],
  ['same-state loads', share(loads, (l) => l.origin.state === l.dest.state), 0.033, null, `no load-level source: board sample says 3.3% (biased); Census CFS says most truck TONS stay in-state, but that is mostly <50 mi local freight`],
  ['peak minute ÷ average minute', Math.max(...minutes) / mean(minutes), 3, 1.5, 'assumption: morning posting peak'],
];

const fmt = (x: number) => (Math.abs(x) < 10 ? x.toFixed(3) : x.toFixed(0));
let failed = 0;
console.log(`${loads.length} loads, ${posts.length} postings, ${new Set(loads.map((l) => l.origin.city + l.origin.state)).size} distinct origin towns\n`);
console.log('check'.padEnd(32), 'generated'.padStart(10), 'target'.padStart(16), '  ', 'source');
for (const [name, v, target, tol, src] of checks) {
  const ok = tol === null || Math.abs(v - target) <= tol;
  if (!ok) failed++;
  console.log(name.padEnd(32), fmt(v).padStart(10), (tol === null ? `(${fmt(target)})` : `${fmt(target)} ± ${fmt(tol)}`).padStart(16), tol === null ? 'info' : ok ? ' ok ' : 'FAIL', src);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
