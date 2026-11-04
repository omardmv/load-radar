// Pair features for the same-load decision. The ONLY place features are computed: training data
// (ml/dedup/export_pairs.ts) and the engine both call pairFeatures(), so they cannot drift apart.
import { milesBetween } from '../shared/geo.ts';
import { jaroWinkler } from '../shared/strings.ts';
import type { Load } from '../shared/types.ts';

export type PairSide = {
  rate: number | null; brokerMc: string; postedAt: number; board: string;
  originCity: string; destCity: string; originLat: number; originLon: number; destLat: number; destLon: number;
  miles: number; equipmentDetail: string; weightLbs: number | null; notes: string;
};

export const sideOf = (l: Load): PairSide => ({
  rate: l.rate, brokerMc: l.brokerMc, postedAt: l.postedAt, board: l.board,
  originCity: l.origin.city.toUpperCase(), destCity: l.dest.city.toUpperCase(),
  originLat: l.origin.lat, originLon: l.origin.lon, destLat: l.dest.lat, destLon: l.dest.lon,
  miles: l.miles, equipmentDetail: l.equipmentDetail.toUpperCase(), weightLbs: l.weightLbs, notes: l.notes,
});

export const FEATURE_NAMES = [
  'rate_rel_diff', 'rate_missing', 'rate_ratio', 'same_broker', 'dt_hours', 'same_board',
  'origin_name_sim', 'dest_name_sim', 'origin_miles', 'dest_miles', 'miles_rel_diff', 'same_equipment_detail',
  // a real load keeps its weight and its comments on every board and every repost
  'weight_rel_diff', 'weight_missing', 'notes_sim',
  // shapes a linear model can't build by itself: a co-broker re-posts at ~5-12% under the original rate,
  // and rate/time mean different things for the same broker vs another broker
  'cobroker_band_dist', 'other_broker_x_dt', 'same_broker_x_rate_diff',
] as const;

export function pairFeatures(c: PairSide, l: PairSide): number[] {
  const missing = c.rate === null || l.rate === null;
  const noWeight = c.weightLbs === null || l.weightLbs === null;
  const sameBroker = c.brokerMc === l.brokerMc;
  const dtHours = Math.abs(c.postedAt - l.postedAt) / 3_600_000;
  return [
    missing ? 0 : Math.abs(c.rate! - l.rate!) / Math.max(c.rate!, l.rate!),
    missing ? 1 : 0,
    missing ? 1 : Math.min(2, l.rate! / c.rate!),
    c.brokerMc === l.brokerMc ? 1 : 0,
    Math.min(12, Math.abs(c.postedAt - l.postedAt) / 3_600_000),
    c.board === l.board ? 1 : 0,
    jaroWinkler(c.originCity, l.originCity),
    jaroWinkler(c.destCity, l.destCity),
    Math.min(100, milesBetween(c.originLat, c.originLon, l.originLat, l.originLon)) / 100,
    Math.min(100, milesBetween(c.destLat, c.destLon, l.destLat, l.destLon)) / 100,
    Math.abs(c.miles - l.miles) / Math.max(1, c.miles, l.miles),
    c.equipmentDetail === l.equipmentDetail ? 1 : 0,
    noWeight ? 0 : Math.min(1, Math.abs(c.weightLbs! - l.weightLbs!) / Math.max(c.weightLbs!, l.weightLbs!)),
    noWeight ? 1 : 0,
    c.notes && l.notes ? jaroWinkler(c.notes, l.notes) : 0,
    missing ? 1 : Math.min(1, Math.abs(l.rate! / c.rate! - 0.915) * 5),
    sameBroker ? 0 : Math.min(12, dtHours),
    sameBroker && !missing ? Math.abs(c.rate! - l.rate!) / Math.max(c.rate!, l.rate!) : 0,
  ];
}
