// Dedup (LLD 6.6): is this posting a load we've already seen?
//   stage 1, exact: same board id (refresh) or same id with new content (update)
//   stage 2, same-load decision on candidates that share pickup date, origin area, destination area and equipment:
//            the hand-written rule (default) or the trained classifier (src/dedup/classifier.ts, --dedup-model)
import type { Clock } from '../shared/clock.ts';
import { createExpiringMap } from '../shared/expiring.ts';
import { neighborCells } from '../shared/geo.ts';
import type { Load } from '../shared/types.ts';
import { sideOf, type PairSide } from './features.ts';

type Seen = { hash: string; canonicalId: string };
type Entry = PairSide & { canonicalId: string };
export type DedupResult = { result: 'refresh' | 'updated' | 'merged' | 'new'; canonicalId: string; candidates: number };
export type SameLoad = (candidate: PairSide, posting: PairSide) => boolean;

const HOUR = 3_600_000;
const TTL = 72 * HOUR;

// The Day 1 rule, kept as the baseline. Same broker: rate within 13% and 6 h.
// Different broker: a co-broker copy (85–97% of the rate, within 1 h).
export const sameLoadRule: SameLoad = (c, l) => {
  const dt = Math.abs(c.postedAt - l.postedAt);
  if (c.brokerMc === l.brokerMc) return dt <= 6 * HOUR && (c.rate === null || l.rate === null || Math.abs(c.rate - l.rate) / c.rate <= 0.13);
  if (c.rate === null || l.rate === null || dt > HOUR) return false;
  const ratio = l.rate / c.rate;
  return ratio >= 0.85 && ratio <= 0.97;
};

export function createDedup(clock: Clock, sameLoad: SameLoad = sameLoadRule) {
  const seen = createExpiringMap<Seen>(TTL, HOUR, clock);
  const blocks = createExpiringMap<Entry[]>(TTL, HOUR, clock);
  let next = 1;
  return (l: Load): DedupResult => {
    const prev = seen.get(l.key);
    if (prev) {
      l.canonicalId = prev.canonicalId;
      if (prev.hash === l.contentHash) return { result: 'refresh', canonicalId: prev.canonicalId, candidates: 0 };
      seen.set(l.key, { hash: l.contentHash, canonicalId: prev.canonicalId });
      return { result: 'updated', canonicalId: prev.canonicalId, candidates: 0 };
    }
    const side = sideOf(l);
    let candidates = 0;
    for (const oc of neighborCells(l.origin.lat, l.origin.lon, 4)) {
      const list = blocks.get(`${l.pickupDate}|${oc}|${l.dest.cell4}|${l.equipment}`);
      if (!list) continue;
      for (const c of list) {
        candidates++;
        if (Math.abs(c.postedAt - l.postedAt) > 6 * HOUR || !sameLoad(c, side)) continue;
        l.canonicalId = c.canonicalId;
        seen.set(l.key, { hash: l.contentHash, canonicalId: c.canonicalId });
        return { result: 'merged', canonicalId: c.canonicalId, candidates };
      }
    }
    l.canonicalId = `C${next++}`;
    seen.set(l.key, { hash: l.contentHash, canonicalId: l.canonicalId });
    const k = `${l.pickupDate}|${l.origin.cell4}|${l.dest.cell4}|${l.equipment}`;
    const entry = { ...side, canonicalId: l.canonicalId };
    const list = blocks.get(k);
    if (list) list.push(entry); else blocks.set(k, [entry]);
    return { result: 'new', canonicalId: l.canonicalId, candidates };
  };
}
