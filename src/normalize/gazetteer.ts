import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PlaceHit = { city: string; state: string; lat: number; lon: number };
const norm = (s: string) => s.toUpperCase().replace(/[.,']/g, '').replace(/^SAINT /, 'ST ').replace(/^FORT /, 'FT ').replace(/^MOUNT /, 'MT ').replace(/\s+/g, ' ').trim();
const ALIASES: Record<string, string> = { 'LA': 'LOS ANGELES', 'VERNON': 'LOS ANGELES', 'KANSAS CTY': 'KANSAS CITY', 'ONTARIO (INLAND EMPIRE)': 'ONTARIO' };

// Place lookup (LLD 6.5): exact, aliases, 14-character truncation. Built once in memory.
export function loadGazetteer(dataDir: string): (city: string, state: string) => PlaceHit | null {
  const exact = new Map<string, PlaceHit>();
  const byState = new Map<string, [string, PlaceHit][]>();
  const add = (city: string, state: string, lat: number, lon: number) => {
    const k = `${norm(city)}|${state}`;
    if (exact.has(k)) return;
    const p = { city, state, lat, lon };
    exact.set(k, p);
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state)!.push([norm(city), p]);
  };
  for (const m of JSON.parse(readFileSync(join(dataDir, 'markets.json'), 'utf8')).markets) add(m.city, m.state, m.lat, m.lon);
  for (const t of JSON.parse(readFileSync(join(dataDir, 'towns.json'), 'utf8')).towns) add(t.name, t.state, t.lat, t.lon);
  return (city, state) => {
    let n = norm(city);
    n = ALIASES[n] ?? n;
    const hit = exact.get(`${n}|${state}`);
    if (hit) return hit;
    if (n.length === 14) for (const [name, p] of byState.get(state) ?? []) if (name.startsWith(n)) return p;
    return null;
  };
}
