// Place index for search parsing (cold path): exact names, aliases, typo tolerance, and ambiguity detection.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normPlaceName } from '../normalize/gazetteer.ts';
import { jaroWinkler } from '../shared/strings.ts';

export type KnownPlace = { city: string; state: string; lat: number; lon: number; pop: number };
export type Resolution = { place: KnownPlace | null; candidates: KnownPlace[]; ambiguous: boolean; via: 'exact' | 'alias' | 'fuzzy' | 'none' };
export type PlaceIndex = { resolve(name: string, state?: string): Resolution };

const ALIASES: Record<string, string> = { LA: 'LOS ANGELES', KC: 'KANSAS CITY', STL: 'ST LOUIS', DFW: 'DALLAS', ATL: 'ATLANTA', VERNON: 'LOS ANGELES' };
const AMBIGUOUS_POP = 50_000;
const FUZZY_MIN = 0.92;
const NONE: Resolution = { place: null, candidates: [], ambiguous: false, via: 'none' };

export function createPlaceIndex(dataDir: string): PlaceIndex {
  const byName = new Map<string, KnownPlace[]>();
  const byLetter = new Map<string, string[]>();
  const add = (city: string, state: string, lat: number, lon: number, pop: number) => {
    const n = normPlaceName(city);
    let list = byName.get(n);
    if (!list) {
      list = [];
      byName.set(n, list);
      const letter = byLetter.get(n[0]);
      if (letter) letter.push(n); else byLetter.set(n[0], [n]);
    }
    if (!list.some((p) => p.state === state)) list.push({ city, state, lat, lon, pop });
  };
  for (const m of JSON.parse(readFileSync(join(dataDir, 'markets.json'), 'utf8')).markets) add(m.city, m.state, m.lat, m.lon, m.pop * 1e6);
  for (const t of JSON.parse(readFileSync(join(dataDir, 'towns.json'), 'utf8')).towns) add(t.name, t.state, t.lat, t.lon, t.pop);
  for (const list of byName.values()) list.sort((a, b) => b.pop - a.pop);

  const pick = (list: KnownPlace[], state: string | undefined, via: Resolution['via']): Resolution => {
    const c = state ? list.filter((p) => p.state === state) : list;
    if (!c.length) return NONE;
    const bigStates = new Set(c.filter((p) => p.pop >= AMBIGUOUS_POP).map((p) => p.state));
    return { place: c[0], candidates: c, ambiguous: !state && bigStates.size > 1, via };
  };

  return {
    resolve(name, state) {
      const n = normPlaceName(name);
      if (!n) return NONE;
      const exact = byName.get(n);
      if (exact) { const r = pick(exact, state, 'exact'); if (r.place) return r; }
      const alias = ALIASES[n];
      if (alias && byName.has(alias)) { const r = pick(byName.get(alias)!, state, 'alias'); if (r.place) return r; }
      let best: Resolution = NONE, bestScore = FUZZY_MIN;
      for (const cand of byLetter.get(n[0]) ?? []) {
        const s = jaroWinkler(n, cand);
        if (s <= bestScore) continue;
        const r = pick(byName.get(cand)!, state, 'fuzzy');
        if (r.place) { best = r; bestScore = s; }
      }
      return best;
    },
  };
}
