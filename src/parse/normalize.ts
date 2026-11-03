// Turns extracted spans into a validated search. Everything that interprets text lives here, so every extractor
// (rules, GLiNER2, LLM) is judged on equal terms. Never guesses silently: unclear fields become questions.
import { DH_PATTERNS, RATE_PATTERNS } from './extract.ts';
import type { PlaceIndex, Resolution } from './places.ts';
import { ANYWHERE, DIRECTIONS, REGIONS, STATES, stateCode } from './regions.ts';
import type { ParseResult, ParsedDest, RawFields, Source } from './types.ts';

export const DEFAULT_DEADHEAD_MI = 100;
export const DEFAULT_DEST_RADIUS_MI = 150;

const firstNumber = (s: string) => { const m = /(\d+(?:\.\d+)?)/.exec(s); return m ? Number(m[1]) : null; };

export function parseRate(s?: string): number | null {
  if (!s) return null;
  let x: number | null = null;
  for (const re of RATE_PATTERNS) { const m = re.exec(s); if (m) { x = Number(m[1]); break; } }
  if (x === null) x = firstNumber(s);
  return x !== null && x >= 0.5 && x <= 15 ? x : null;
}

export function parseDeadhead(s?: string): number | null {
  if (!s) return null;
  let x: number | null = null;
  for (const re of DH_PATTERNS) { const m = re.exec(s); if (m) { x = Number(m[1]); break; } }
  if (x === null) x = firstNumber(s);
  return x !== null && x >= 10 && x <= 500 ? Math.round(x) : null;
}

export function splitCityState(t: string): { city: string; state?: string } {
  const s = t.trim().replace(/[.,]+$/, '');
  const m = /^(.*?)[,\s]+([A-Za-z]{2})$/.exec(s);
  if (m && m[1].trim() && STATES[m[2].toUpperCase()]) return { city: m[1].trim(), state: m[2].toUpperCase() };
  return { city: s };
}

const whichOne = (r: Resolution) =>
  `Which ${r.place!.city}: ${r.candidates.filter((p) => p.pop >= 50_000).slice(0, 3).map((p) => `${p.city}, ${p.state}`).join(' or ')}?`;

export function normalizeFields(raw: RawFields, places: PlaceIndex, from: Partial<Record<keyof RawFields, 'rules' | 'model'>> = {}): ParseResult {
  const questions: string[] = [];
  const sources: ParseResult['sources'] = {};
  const src = (k: keyof RawFields): Source => from[k] ?? 'rules';

  let equipment: ParseResult['equipment'] = null;
  if (raw.equipment && raw.equipment !== 'unspecified') { equipment = raw.equipment; sources.equipment = src('equipment'); }
  else questions.push('Which equipment: van, reefer or flatbed?');

  let origin: ParseResult['origin'] = null;
  if (raw.originText) {
    const { city, state } = splitCityState(raw.originText);
    const r = places.resolve(city, state);
    if (r.place) { origin = r.place; sources.origin = src('originText'); if (r.ambiguous) questions.push(whichOne(r)); }
    else questions.push(`I couldn't find "${raw.originText}". Where is the truck?`);
  } else questions.push('Where is the truck?');

  let dest: ParsedDest | null = null;
  const destText = (raw.destText ?? '').trim().replace(/^the\s+/i, '');
  if (!destText || ANYWHERE.has(destText.toLowerCase())) { dest = { kind: 'anywhere' }; sources.dest = destText ? src('destText') : 'default'; }
  else {
    const codes = destText.split(/\s*(?:\/|,|&|\band\b)\s*/i).filter(Boolean).map(stateCode);
    const region = REGIONS[destText.toUpperCase()];
    if (codes.length && codes.every((c) => c !== null)) {
      dest = { kind: 'states', states: [...new Set(codes as string[])].sort() };
      sources.dest = src('destText');
      if (destText.toUpperCase() === 'LA') questions.push('LA: Louisiana or Los Angeles, CA?');
    } else if (region) {
      dest = { kind: 'states', states: [...region].sort() };
      sources.dest = src('destText');
    } else if (DIRECTIONS.has(destText.toLowerCase())) {
      questions.push(`Which states do you mean by "${destText}"?`);
    } else {
      const { city, state } = splitCityState(destText);
      const r = places.resolve(city, state);
      if (r.place) {
        dest = { kind: 'point', lat: r.place.lat, lon: r.place.lon, radiusMi: raw.destRadiusMi ?? DEFAULT_DEST_RADIUS_MI, label: `${r.place.city}, ${r.place.state}` };
        sources.dest = src('destText');
        if (r.ambiguous) questions.push(whichOne(r));
      } else questions.push(`I couldn't find "${destText}" as a destination.`);
    }
  }

  const minRpm = parseRate(raw.rateText);
  if (minRpm !== null) sources.minRpm = src('rateText');
  const dh = parseDeadhead(raw.deadheadText);
  sources.deadheadMi = dh !== null ? src('deadheadText') : 'default';

  return { equipment, origin, dest, minRpm, deadheadMi: dh ?? DEFAULT_DEADHEAD_MI, questions, sources };
}

// The confirmation sentence shown to the dispatcher (LLD 6.1).
export function describe(r: ParseResult): string {
  const eq = r.equipment ? r.equipment[0].toUpperCase() + r.equipment.slice(1) : 'Equipment?';
  const from = r.origin ? `within ${r.deadheadMi} mi of ${r.origin.city}, ${r.origin.state}` : 'origin?';
  const to = !r.dest ? 'destination?' : r.dest.kind === 'anywhere' ? 'anywhere' : r.dest.kind === 'states' ? r.dest.states.join('/') : `${r.dest.label} (within ${r.dest.radiusMi} mi)`;
  const rate = r.minRpm !== null ? `≥ $${r.minRpm.toFixed(2)}/mi` : 'any rate';
  return `${eq} · ${from} → ${to} · ${rate}`;
}
