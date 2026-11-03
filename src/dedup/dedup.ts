import type { Clock } from '../shared/clock.ts';
import { createExpiringMap } from '../shared/expiring.ts';
import { neighborCells } from '../shared/geo.ts';
import type { Load } from '../shared/types.ts';

type Seen = { hash: string; canonicalId: string };
type Entry = { canonicalId: string; rate: number | null; brokerMc: string; postedAt: number };
export type DedupResult = { result: 'refresh' | 'updated' | 'merged' | 'new'; canonicalId: string; candidates: number };

const HOUR = 3_600_000;
const TTL = 72 * HOUR;

// Stand-in for the trained classifier (LLD 6.6). Same broker: rate within 13% and 6 h. Different broker:
// a co-broker copy (85–97% of the rate, within 1 h).
function sameLoad(c: Entry, l: Load): boolean {
  const dt = Math.abs(c.postedAt - l.postedAt);
  if (c.brokerMc === l.brokerMc) return dt <= 6 * HOUR && (c.rate === null || l.rate === null || Math.abs(c.rate - l.rate) / c.rate <= 0.13);
  if (c.rate === null || l.rate === null || dt > HOUR) return false;
  const ratio = l.rate / c.rate;
  return ratio >= 0.85 && ratio <= 0.97;
}

export function createDedup(clock: Clock) {
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
    let candidates = 0;
    for (const oc of neighborCells(l.origin.lat, l.origin.lon, 4)) {
      const list = blocks.get(`${l.pickupDate}|${oc}|${l.dest.cell4}|${l.equipment}`);
      if (!list) continue;
      for (const c of list) {
        candidates++;
        if (!sameLoad(c, l)) continue;
        l.canonicalId = c.canonicalId;
        seen.set(l.key, { hash: l.contentHash, canonicalId: c.canonicalId });
        return { result: 'merged', canonicalId: c.canonicalId, candidates };
      }
    }
    l.canonicalId = `C${next++}`;
    seen.set(l.key, { hash: l.contentHash, canonicalId: l.canonicalId });
    const k = `${l.pickupDate}|${l.origin.cell4}|${l.dest.cell4}|${l.equipment}`;
    const list = blocks.get(k);
    const entry = { canonicalId: l.canonicalId, rate: l.rate, brokerMc: l.brokerMc, postedAt: l.postedAt };
    if (list) list.push(entry); else blocks.set(k, [entry]);
    return { result: 'new', canonicalId: l.canonicalId, candidates };
  };
}
