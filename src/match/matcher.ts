import { coverCells } from '../shared/geo.ts';
import type { Load, SearchSpec } from '../shared/types.ts';
import { specMatches } from './filters.ts';

// Index: geohash level-3 cell + equipment -> searches whose deadhead circle touches the cell (LLD 6.7).
export function buildMatcher(specs: SearchSpec[]) {
  const index = new Map<string, SearchSpec[]>();
  let indexEntries = 0;
  for (const s of specs) {
    for (const c of coverCells(s.lat, s.lon, s.deadheadMi, 3)) {
      const k = `${c}|${s.equipment}`;
      const list = index.get(k);
      if (list) list.push(s); else index.set(k, [s]);
      indexEntries++;
    }
  }
  return {
    indexEntries,
    match(l: Load): { candidates: number; users: Map<string, string[]> } {
      const cands = index.get(`${l.origin.cell4.slice(0, 3)}|${l.equipment}`) ?? [];
      const users = new Map<string, string[]>();
      const onlyUser = l.visibleTo.kind === 'user' ? l.visibleTo.userId : null;
      for (const s of cands) {
        if (onlyUser !== null && s.userId !== onlyUser) continue;     // entitlement
        if (!specMatches(s, l)) continue;
        const list = users.get(s.userId);
        if (list) list.push(s.searchId); else users.set(s.userId, [s.searchId]);
      }
      return { candidates: cands.length, users };
    },
  };
}
