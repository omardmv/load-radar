import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PlaceHit = { city: string; state: string; lat: number; lon: number };
export const normPlaceName = (s: string) => s.toUpperCase().replace(/[.,']/g, '').replace(/^SAINT /, 'ST ').replace(/^FORT /, 'FT ').replace(/^MOUNT /, 'MT ').replace(/\s+/g, ' ').trim();
const ALIASES: Record<string, string> = { 'LA': 'LOS ANGELES', 'VERNON': 'LOS ANGELES', 'KANSAS CTY': 'KANSAS CITY', 'ONTARIO (INLAND EMPIRE)': 'ONTARIO' };

// Place lookup (LLD 6.5): exact, aliases, 14-character truncation. Built once in memory.
export function loadGazetteer(dataDir: string): (city: string, state: string) => PlaceHit | null {
  const exact = new Map<string, PlaceHit>();
  const byState = new Map<string, [string, PlaceHit][]>();
  const add = (city: string, state: string, lat: number, lon: number) => {
    const k = `${normPlaceName(city)}|${state}`;
    if (exact.has(k)) return;
    const p = { city, state, lat, lon };
    exact.set(k, p);
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state)!.push([normPlaceName(city), p]);
  };
  for (const m of JSON.parse(readFileSync(join(dataDir, 'markets.json'), 'utf8')).markets) add(m.city, m.state, m.lat, m.lon);
  for (const t of JSON.parse(readFileSync(join(dataDir, 'towns.json'), 'utf8')).towns) add(t.name, t.state, t.lat, t.lon);
  return (city, state) => {
    let n = normPlaceName(city);
    n = ALIASES[n] ?? n;
    const hit = exact.get(`${n}|${state}`);
    if (hit) return hit;
    // Truckstop cuts names at 14 characters. Decide that on the raw text: normalizing changes the length
    // ("FORT LAUDERDAL" -> "FT LAUDERDAL", dots dropped, a cut that ends on a space is trimmed).
    if (city.length !== 14 || !n) return null;
    const prefix = /\s$/.test(city) ? `${n} ` : n;   // cut on a space: the next word must start there
    const alias = Object.keys(ALIASES).find((a) => a.length > 14 && a.startsWith(prefix));   // "ONTARIO (INLAN"
    if (alias) { const p = exact.get(`${ALIASES[alias]}|${state}`); if (p) return p; }
    let best: [string, PlaceHit] | null = null;      // several towns share a prefix: take the shortest name
    for (const e of byState.get(state) ?? []) if (e[0].startsWith(prefix) && (!best || e[0].length < best[0].length)) best = e;
    return best ? best[1] : null;
  };
}
