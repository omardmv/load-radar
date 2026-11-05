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

type Expect = { userId: string; loadId: string; postedAt: number; coveredAt: number; searchIds: string[] };
export type Counters = { expected: number; delivered: number; missed: number; missedOpen5Min: number; duplicates: number; unexpected: number; backfill: number; late: number; cancelled: number; latency: number[] };
const empty = (): Counters => ({ expected: 0, delivered: 0, missed: 0, missedOpen5Min: 0, duplicates: 0, unexpected: 0, backfill: 0, late: 0, cancelled: 0, latency: [] });

export function createLiveScore(opts: { users: User[]; watch: string; createdAt: Map<string, number> }) {
  let index = new Map<string, { spec: SearchSpec; boards: Set<string> }[]>();
  const rebuild = () => {
    // Searches removed: their pending expectations no longer count (the engine cancels those alerts too).
    const active = new Set(opts.users.flatMap((u) => u.searches.map((s) => s.searchId)));
    for (const [key, e] of pending) if (!e.searchIds.some((id) => active.has(id))) { pending.delete(key); count(e.userId, (c) => { c.expected--; c.cancelled++; }); }
    index = new Map();
    for (const u of opts.users) {
      const boards = new Set(u.credentials.map((c) => c.board as string));
      for (const s of u.searches) for (const c of coverCells(s.lat, s.lon, s.deadheadMi, 3)) {
        const l = index.get(c); const e = { spec: s, boards };
        if (l) l.push(e); else index.set(c, [e]);
      }
    }
  };
  const pending = new Map<string, Expect>();          // "user|load" -> expectation
  const seen = new Set<string>();                     // delivered "user|load" (for duplicates)
  const missedKeys = new Set<string>();               // counted missed, may still arrive late
  const all = empty(), mine = empty();                // everyone vs the watched user (you)
  const count = (userId: string, f: (c: Counters) => void) => { f(all); if (userId === opts.watch) f(mine); };
  rebuild();

  function onLoad(t: Truth) {
    const firstPosted = Date.parse(t.first_posted_at);
    const coveredAt = coverTime(t.load_id, firstPosted);   // the load is taken on its own clock, whoever sees it
    const l: MatchableLoad = { postedAt: firstPosted, equipment: t.equipment, rate: t.rate, miles: t.miles, pickupDate: t.pickup_date,
      origin: { ...t.origin, cell4: geohash(t.origin.lat, t.origin.lon, 4) }, dest: { ...t.dest, cell4: geohash(t.dest.lat, t.dest.lon, 4) } };
    // The clock starts when the load first appears on a board this user can see, not on any board: a co-broker
    // repost ~10 min later on another board can't be alerted sooner than that.
    const firstSeen = (has: Set<string>) => Math.min(...t.postings.filter((p) => has.has(p.board)).map((p) => Date.parse(p.posted_at)));
    const users = new Map<string, { postedAt: number; searchIds: string[] }>();
    for (const { spec, boards: has } of index.get(geohash(t.origin.lat, t.origin.lon, 3)) ?? []) {
      const postedAt = firstSeen(has);
      if (!Number.isFinite(postedAt) || !specMatches(spec, l)) continue;           // not on any of the user's boards
      if ((opts.createdAt.get(spec.searchId) ?? 0) > postedAt) continue;            // search made after the load
      const u = users.get(spec.userId);
      if (u) u.searchIds.push(spec.searchId); else users.set(spec.userId, { postedAt, searchIds: [spec.searchId] });
    }
    for (const [userId, { postedAt, searchIds }] of users) {
      pending.set(`${userId}|${t.load_id}`, { userId, loadId: t.load_id, postedAt, coveredAt, searchIds });
      count(userId, (c) => c.expected++);
    }
  }

  // Newest search per user: a new search also alerts on matching loads already open on the board ("backfill").
  // The answer key is built when a load is born, so those are counted apart, not as unexpected.
  const newestSearch = (userId: string) => Math.max(0, ...(opts.users.find((u) => u.userId === userId)?.searches ?? []).map((s) => opts.createdAt.get(s.searchId) ?? 0));
  type Checked = { loadId: string; latencySec: number | null; expected: boolean; backfill?: boolean; late?: boolean };
  function onDelivery(d: Delivery, loadOf: (key: string) => Truth | undefined): Checked[] {
    const out: Checked[] = [];
    for (const x of d.loads) {
      const t = loadOf(x.loadKey);
      if (!t) continue;
      const key = `${d.chatId}|${t.load_id}`;
      if (seen.has(key)) { count(d.chatId, (c) => c.duplicates++); continue; }
      seen.add(key);
      const e = pending.get(key);
      if (!e && missedKeys.delete(key)) {             // arrived after the cutoff: was counted missed, now late
        count(d.chatId, (c) => { c.late++; });
        out.push({ loadId: t.load_id, latencySec: (d.at - Date.parse(t.first_posted_at)) / 1000, expected: false, late: true });
        continue;
      }
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
      missedKeys.add(key);
      count(e.userId, (c) => { c.missed++; if (e.coveredAt - e.postedAt >= 5 * 60_000) c.missedOpen5Min++; });
    }
    if (seen.size > 2_000_000) seen.clear();
    if (missedKeys.size > 500_000) missedKeys.clear();
  }

  const summary = (c: Counters) => {
    const lat = [...c.latency].sort((a, b) => a - b);
    const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null);
    const settled = c.delivered + c.missed;
    return { expected: c.expected, delivered: c.delivered, missed: c.missed, missedOpen5Min: c.missedOpen5Min, duplicates: c.duplicates, unexpected: c.unexpected, backfill: c.backfill, late: c.late, cancelled: c.cancelled,
      missRate: settled ? c.missed / settled : 0, latencySec: { p50: pct(50), p95: pct(95), p99: pct(99) } };
  };
  return { onLoad, onDelivery, sweep, rebuild, summary: () => ({ all: summary(all), you: summary(mine), pending: pending.size }) };
}
