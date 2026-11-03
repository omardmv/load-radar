import { centralDate, daysBetween, milesBetween } from '../shared/geo.ts';
import type { Load, SearchSpec } from '../shared/types.ts';

export type MatchableLoad = Pick<Load, 'origin' | 'dest' | 'equipment' | 'rate' | 'miles' | 'pickupDate' | 'postedAt'>;

// Exact filters (LLD 6.7). The pickup window is measured from the load's posting date (US Central).
export function specMatches(s: SearchSpec, l: MatchableLoad): boolean {
  if (s.equipment !== l.equipment) return false;
  if (milesBetween(s.lat, s.lon, l.origin.lat, l.origin.lon) > s.deadheadMi) return false;
  if (s.dest.kind === 'states' && !s.dest.states.includes(l.dest.state)) return false;
  if (s.dest.kind === 'point' && milesBetween(s.dest.lat, s.dest.lon, l.dest.lat, l.dest.lon) > s.dest.radiusMi) return false;
  if (l.rate === null) { if (!s.includeNoRate) return false; }
  else if (s.minRpm !== null && l.rate / l.miles < s.minRpm) return false;
  const d = daysBetween(centralDate(l.postedAt), l.pickupDate);
  return d >= 0 && d <= s.pickupWithinDays;
}
