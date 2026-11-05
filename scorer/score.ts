// Compares delivered alerts with the generator's answer key (LLD §15): latency, misses, duplicates.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadUsers } from '../src/data/users.ts';
import { specMatches, type MatchableLoad } from '../src/match/filters.ts';
import { coverCells, geohash } from '../src/shared/geo.ts';
import { coverTime } from '../sims/cover.ts';
import type { Delivery } from '../sims/telegram-sim.ts';

export type ScoreReport = { expected: number; delivered: number; missed: number; missRate: number; missedOpen5Min: number; duplicates: number; duplicateRate: number; unexpected: number; latencySec: { p50: number; p95: number; p99: number } };
type TruthLoad = MatchableLoad & { id: string; boards: Map<string, number>; coveredAt: number };   // board -> first posted there

const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()) : []);
const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

export function score(input: { truthFile: string; searchesFile: string; deliveriesFile: string; windowStart: number; windowEnd: number; settleMs: number }): ScoreReport {
  const keyToLoad = new Map<string, string>();
  const byCell = new Map<string, TruthLoad[]>();
  const loads = new Map<string, TruthLoad>();
  for (const line of lines(input.truthFile)) {
    const l = JSON.parse(line);
    for (const p of l.postings) keyToLoad.set(`${p.board}:${p.board_load_id}`, l.load_id);
    const first = Date.parse(l.first_posted_at);
    if (first < input.windowStart || first > input.windowEnd - input.settleMs) continue;
    const boards = new Map<string, number>();
    for (const p of l.postings) { const at = Date.parse(p.posted_at); if (at <= input.windowEnd && !(at >= (boards.get(p.board) ?? Infinity))) boards.set(p.board, at); }
    const t: TruthLoad = { id: l.load_id, boards,
      coveredAt: coverTime(l.load_id, first), postedAt: first, equipment: l.equipment, rate: l.rate, miles: l.miles, pickupDate: l.pickup_date,
      origin: { ...l.origin, cell4: geohash(l.origin.lat, l.origin.lon, 4) }, dest: { ...l.dest, cell4: geohash(l.dest.lat, l.dest.lon, 4) } };
    loads.set(t.id, t);
    const c = geohash(t.origin.lat, t.origin.lon, 3);
    if (!byCell.has(c)) byCell.set(c, []);
    byCell.get(c)!.push(t);
  }
  // "user|load" -> when the load first appeared on a board this user can see: the clock for latency and misses.
  // Not first_posted_at: a co-broker repost ~10 min later on another board can't be alerted sooner than that.
  const expected = new Map<string, number>();
  for (const u of loadUsers(input.searchesFile)) {
    const boards = new Set(u.credentials.map((c) => c.board));
    for (const s of u.searches) for (const cell of coverCells(s.lat, s.lon, s.deadheadMi, 3)) for (const l of byCell.get(cell) ?? []) {
      const seen = Math.min(...[...l.boards].filter(([b]) => boards.has(b)).map(([, at]) => at));
      if (Number.isFinite(seen) && specMatches(s, l)) expected.set(`${u.userId}|${l.id}`, seen);
    }
  }
  const first = new Map<string, number>();
  let duplicates = 0, unexpected = 0;
  for (const line of lines(input.deliveriesFile)) {
    const d: Delivery = JSON.parse(line);
    for (const x of d.loads) {
      const loadId = keyToLoad.get(x.loadKey);
      if (!loadId) continue;
      const k = `${d.chatId}|${loadId}`;
      if (first.has(k)) { duplicates++; continue; }
      first.set(k, d.at);
      if (!expected.has(k)) unexpected++;
    }
  }
  const lat: number[] = [];
  let missed = 0, missedOpen5Min = 0;
  for (const [k, seenAt] of expected) {
    const at = first.get(k);
    const l = loads.get(k.split('|')[1])!;
    if (at === undefined) { missed++; if (l.coveredAt - seenAt >= 5 * 60_000) missedOpen5Min++; continue; }
    lat.push((at - seenAt) / 1000);
  }
  lat.sort((a, b) => a - b);
  const delivered = expected.size - missed;
  return { expected: expected.size, delivered, missed, missRate: expected.size ? missed / expected.size : 0, missedOpen5Min,
    duplicates, duplicateRate: delivered ? duplicates / delivered : 0, unexpected, latencySec: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { truth: { type: 'string' }, searches: { type: 'string' }, deliveries: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, settle: { type: 'string', default: '600000' } } });
  console.log(JSON.stringify(score({ truthFile: a.truth!, searchesFile: a.searches!, deliveriesFile: a.deliveries!, windowStart: Date.parse(a.start!), windowEnd: Date.parse(a.end!), settleMs: Number(a.settle) }), null, 2));
}
