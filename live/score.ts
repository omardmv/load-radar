// Live answer key: the same rules as scorer/score.ts, but rolling. When a load is born we already know who
// should hear about it (searches that match it, on a board the user has a login for). Each delivery is checked
// against that; anything still undelivered after SETTLE_MS counts as missed.
import { coverCells, geohash } from '../src/shared/geo.ts';
import { specMatches, type MatchableLoad } from '../src/match/filters.ts';
import type { SearchSpec, User } from '../src/shared/types.ts';
import type { Delivery } from '../sims/telegram-sim.ts';
import type { Truth } from '../sim/world.ts';
import { coverTime } from '../sims/cover.ts';

const SETTLE_MS = 15 * 60_000;     // engine gives up on an alert after 10 min; 5 more for slack
const WINDOW = 5_000;              // latency percentiles over the last N deliveries

type Expect = { userId: string; loadId: string; postedAt: number; coveredAt: number };
export type Counters = { expected: number; delivered: number; missed: number; missedOpen5Min: number; duplicates: number; unexpected: number; backfill: number; latency: number[] };
const empty = (): Counters => ({ expected: 0, delivered: 0, missed: 0, missedOpen5Min: 0, duplicates: 0, unexpected: 0, backfill: 0, latency: [] });

export function createLiveScore(opts: { users: User[]; watch: string; createdAt: Map<string, number> }) {
  let index = new Map<string, { spec: SearchSpec; boards: Set<string> }[]>();
  const rebuild = () => {
    index = new Map();
    for (const u of opts.users) {
      const boards = new Set(u.credentials.map((c) => c.board as string));
      for (const s of u.searches) for (const c of coverCells(s.lat, s.lon, s.deadheadMi, 3)) {
        const l = index.get(c); const e = { spec: s, boards };
        if (l) l.push(e); else index.set(c, [e]);
      }
    }
  };
  rebuild();
  const pending = new Map<string, Expect>();          // "user|load" -> expectation
  const seen = new Set<string>();                     // delivered "user|load" (for duplicates)
  const all = empty(), mine = empty();                // everyone vs the watched user (you)
  const count = (userId: string, f: (c: Counters) => void) => { f(all); if (userId === opts.watch) f(mine); };

  function onLoad(t: Truth) {
    const postedAt = Date.parse(t.first_posted_at);
    const boards = new Set(t.postings.map((p) => p.board as string));
    const l: MatchableLoad = { postedAt, equipment: t.equipment, rate: t.rate, miles: t.miles, pickupDate: t.pickup_date,
      origin: { ...t.origin, cell4: geohash(t.origin.lat, t.origin.lon, 4) }, dest: { ...t.dest, cell4: geohash(t.dest.lat, t.dest.lon, 4) } };
    const users = new Set<string>();
    for (const { spec, boards: has } of index.get(geohash(t.origin.lat, t.origin.lon, 3)) ?? []) {
      if (users.has(spec.userId) || (opts.createdAt.get(spec.searchId) ?? 0) > postedAt) continue;   // search made after the load
      if (![...boards].some((b) => has.has(b)) || !specMatches(spec, l)) continue;
      users.add(spec.userId);
    }
    for (const userId of users) {
      pending.set(`${userId}|${t.load_id}`, { userId, loadId: t.load_id, postedAt, coveredAt: coverTime(t.load_id, postedAt) });
      count(userId, (c) => c.expected++);
    }
  }

  // Newest search per user: a new search also alerts on matching loads already open on the board ("backfill").
  // The answer key is built when a load is born, so those are counted apart, not as unexpected.
  const newestSearch = (userId: string) => Math.max(0, ...(opts.users.find((u) => u.userId === userId)?.searches ?? []).map((s) => opts.createdAt.get(s.searchId) ?? 0));
  type Checked = { loadId: string; latencySec: number | null; expected: boolean; backfill?: boolean };
  function onDelivery(d: Delivery, loadOf: (key: string) => Truth | undefined): Checked[] {
    const out: Checked[] = [];
    for (const x of d.loads) {
      const t = loadOf(x.loadKey);
      if (!t) continue;
      const key = `${d.chatId}|${t.load_id}`;
      if (seen.has(key)) { count(d.chatId, (c) => c.duplicates++); continue; }
      seen.add(key);
      const e = pending.get(key);
      if (!e) {
        const backfill = Date.parse(t.first_posted_at) < newestSearch(d.chatId);
        count(d.chatId, (c) => { if (backfill) c.backfill++; else c.unexpected++; });
        out.push({ loadId: t.load_id, latencySec: null, expected: false, backfill });
        continue;
      }
      pending.delete(key);
      const sec = (d.at - e.postedAt) / 1000;
      count(d.chatId, (c) => { c.delivered++; c.latency.push(sec); if (c.latency.length > WINDOW) c.latency.shift(); });
      out.push({ loadId: t.load_id, latencySec: sec, expected: true });
    }
    return out;
  }

  // Undelivered after SETTLE_MS -> missed. "Open 5 min" = the load stayed on the board long enough to catch.
  function sweep(now: number) {
    for (const [key, e] of pending) {
      if (now - e.postedAt < SETTLE_MS) continue;
      pending.delete(key);
      count(e.userId, (c) => { c.missed++; if (e.coveredAt - e.postedAt >= 5 * 60_000) c.missedOpen5Min++; });
    }
    if (seen.size > 2_000_000) seen.clear();
  }

  const summary = (c: Counters) => {
    const lat = [...c.latency].sort((a, b) => a - b);
    const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null);
    const settled = c.delivered + c.missed;
    return { expected: c.expected, delivered: c.delivered, missed: c.missed, missedOpen5Min: c.missedOpen5Min, duplicates: c.duplicates, unexpected: c.unexpected, backfill: c.backfill,
      missRate: settled ? c.missed / settled : 0, latencySec: { p50: pct(50), p95: pct(95), p99: pct(99) } };
  };
  return { onLoad, onDelivery, sweep, rebuild, summary: () => ({ all: summary(all), you: summary(mine), pending: pending.size }) };
}
