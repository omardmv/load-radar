// A world that never stops: new loads arrive all the time (Poisson, shaped by the US Central hour of day),
// each one spreads into board postings over its life (refreshes, reposts, other boards, a co-broker), and
// postings are released to the simulated boards only when they come due. Old data is dropped after a while.
import { createHeap } from '../src/shared/heap.ts';
import { geohash } from '../src/shared/geo.ts';
import type { Clock } from '../src/shared/clock.ts';
import type { BoardData, SimItem } from '../sims/boards-sim.ts';
import { coverTime } from '../sims/cover.ts';
import { HOURLY, centralHour, type Equip, type Posting, type Truth, type World } from '../sim/world.ts';

const HOURLY_SUM = HOURLY.reduce((a, b) => a + b, 0);
const KEEP_MS = 6 * 3_600_000;                       // board history kept (simulated time)

export type Released = { board: string; at: number; loadId: string; kind: string; truth: Truth };

export function createStream(opts: { world: World; clock: Clock; loadsPerDay: number; onLoad(t: Truth): void; onPosting(p: Released): void }) {
  const { world, clock } = opts;
  const k = world.rateScale(Array.from({ length: 4_000 }, () => world.makeLoad(clock.now())));   // rate calibration sample
  const due = createHeap<Posting & { truth: Truth; kind: string }>((a, b) => a.posted_at < b.posted_at);
  const data: BoardData = new Map();
  const keyToLoad = new Map<string, Truth>();         // "board:board_load_id" -> load (deliveries carry this key)
  const byId = new Map<string, Truth>();              // load_id -> load (the agent asks about one load)
  const byAge: { at: number; keys: string[]; id: string }[] = [];
  const stats = { loads: 0, postings: 0, perBoard: {} as Record<string, number> };
  let last = clock.now();
  let loadsPerDay = opts.loadsPerDay;

  const poisson = (mean: number) => {                // Knuth for small means, normal approximation above
    if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * Math.sqrt(-2 * Math.log(1 - world.rand())) * Math.cos(2 * Math.PI * world.rand())));
    let n = 0, p = Math.exp(-mean), s = p; const u = world.rand();
    while (u > s) { n++; p *= mean / n; s += p; }
    return n;
  };

  const addLoad = (load: ReturnType<World['makeLoad']>) => {
    world.finishRate(load, k);
    for (const l of [load, ...world.siblings(load)]) {
      const { postings, truth } = world.postingsFor(l);
      stats.loads++;
      const keys = truth.postings.map((p) => `${p.board}:${p.board_load_id}`);
      for (const key of keys) keyToLoad.set(key, truth);
      byId.set(truth.load_id, truth);
      byAge.push({ at: l.posted_at, keys, id: truth.load_id });
      opts.onLoad(truth);
      postings.forEach((p, i) => due.push({ ...p, truth, kind: truth.postings[i].kind }));
    }
  };

  function tick() {
    const now = clock.now();
    if (now > last) {
      const perMs = (loadsPerDay * HOURLY[centralHour(now)] / HOURLY_SUM) / 3_600_000;
      const n = poisson(perMs * (now - last));
      const times = Array.from({ length: n }, () => last + world.rand() * (now - last)).sort((a, b) => a - b);
      for (const t of times) addLoad(world.makeLoad(t));
      last = now;
    }
    // Release due postings in time order, so each board cell's list stays sorted by postedAt.
    while (due.size() && due.peek()!.posted_at <= now) {
      const p = due.pop()!;
      const t = p.truth;
      const item: SimItem = { postedAt: p.posted_at, coveredAt: coverTime(t.load_id, Date.parse(t.first_posted_at)), lat: t.origin.lat, lon: t.origin.lon, equip: t.equipment, pickup: t.pickup_date, raw: p.raw };
      const cell = geohash(t.origin.lat, t.origin.lon, 3);
      if (!data.has(p.board)) data.set(p.board, new Map());
      const byCell = data.get(p.board)!;
      const list = byCell.get(cell);
      if (list) list.push(item); else byCell.set(cell, [item]);
      stats.postings++;
      stats.perBoard[p.board] = (stats.perBoard[p.board] ?? 0) + 1;
      opts.onPosting({ board: p.board, at: p.posted_at, loadId: t.load_id, kind: p.kind, truth: t });
    }
  }

  function prune() {
    const cutoff = clock.now() - KEEP_MS;
    for (const byCell of data.values()) for (const [cell, list] of byCell) {
      let i = 0; while (i < list.length && list[i].postedAt < cutoff) i++;
      if (i === list.length) byCell.delete(cell); else if (i) list.splice(0, i);
    }
    while (byAge.length && byAge[0].at < cutoff) { const old = byAge.shift()!; for (const key of old.keys) keyToLoad.delete(key); byId.delete(old.id); }
  }

  // A shipper releases a batch: `count` loads out of one market within `windowMs` (tests the hot path).
  function burst(city: string, equip: Equip, count: number, windowMs = 60_000) {
    const make = world.burstPicker(city, equip);
    const now = clock.now();
    for (let i = 0; i < count; i++) addLoad(make(now + world.rand() * windowMs));
  }

  return {
    data, tick, prune, burst, stats,
    loadOf: (key: string) => keyToLoad.get(key),
    loadById: (id: string) => byId.get(id),
    marketRpm: (t: Truth) => world.expectedRpm(t.origin.market, t.equipment, t.miles, k),   // the agent's market-rate tool
    pending: () => due.size(),
    get loadsPerDay() { return loadsPerDay; },
    setLoadsPerDay(n: number) { loadsPerDay = n; },
  };
}
