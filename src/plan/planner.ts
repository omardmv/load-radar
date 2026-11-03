import { coverCells, milesBetween } from '../shared/geo.ts';
import type { Equip, PlanEntry, SearchSpec, User } from '../shared/types.ts';

export const MAX_MERGED_RADIUS_MI = 150;

// Merge one user's searches into the fewest board queries (LLD 6.2); the matcher filters exactly afterwards.
export function buildPlan(user: User, heatOf: (cell3: string, equip: Equip) => number): PlanEntry[] {
  const byEquip = new Map<Equip, SearchSpec[]>();
  for (const s of user.searches) {
    const l = byEquip.get(s.equipment);
    if (l) l.push(s); else byEquip.set(s.equipment, [s]);
  }
  const clusters: { equip: Equip; lat: number; lon: number; radius: number; ids: string[] }[] = [];
  for (const [equip, specs] of byEquip) {
    const own: typeof clusters = [];
    for (const s of [...specs].sort((x, y) => y.deadheadMi - x.deadheadMi)) {
      const c = own.find((k) => milesBetween(k.lat, k.lon, s.lat, s.lon) + s.deadheadMi <= MAX_MERGED_RADIUS_MI);
      if (c) { c.radius = Math.max(c.radius, milesBetween(c.lat, c.lon, s.lat, s.lon) + s.deadheadMi); c.ids.push(s.searchId); }
      else own.push({ equip, lat: s.lat, lon: s.lon, radius: s.deadheadMi, ids: [s.searchId] });
    }
    clusters.push(...own);
  }
  const out: PlanEntry[] = [];
  for (const cred of user.credentials) {
    clusters.forEach((c, i) => {
      const heat = Math.max(0.01, coverCells(c.lat, c.lon, c.radius, 3).reduce((sum, cell) => sum + heatOf(cell, c.equip), 0));
      out.push({ entryId: `${cred.credentialId}:${i}`, credentialId: cred.credentialId, userId: user.userId, board: cred.board,
        query: { lat: c.lat, lon: c.lon, radiusMi: Math.ceil(c.radius), equipment: [c.equip] }, searchIds: [...c.ids], heat, intervalMs: 60_000, cursor: 0 });
    });
  }
  return out;
}

// Square-root rule (LLD 6.3): f_i = B * sqrt(heat_i) / sum sqrt(heat_j), clamped to [every 5 min, every 5 s].
export function allocate(entries: PlanEntry[], budgetPerMin: number, minPerMin = 0.2, maxPerMin = 12): PlanEntry[] {
  const total = entries.reduce((s, e) => s + Math.sqrt(e.heat), 0) || 1;
  return entries.map((e) => {
    const f = Math.min(maxPerMin, Math.max(minPerMin, (budgetPerMin * Math.sqrt(e.heat)) / total));
    return { ...e, intervalMs: 60_000 / f };
  });
}
