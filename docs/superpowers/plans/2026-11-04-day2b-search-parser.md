# Load Radar Day 2B: Hybrid Search Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a dispatcher's free-text search ("reefer outta fresno 3.40+ no more than 100 deadhead") into a validated search, ask instead of guessing when unsure, and choose the extractor by measurement: rules vs GLiNER2 vs hybrid vs a local LLM (Qwen 2.5 1.5B), on one eval set, with every model call logged.

**Architecture:** Extractors only find *text spans* (`RawFields`); one normalizer turns spans into a search using our own place index (typos, aliases, ambiguity), state and region tables, and number parsing, and it adds questions when something is missing or ambiguous. Three extractors: rules (regex, `src/parse/extract.ts`), GLiNER2 (a small Python HTTP service on the cold path), and Qwen via Ollama with a JSON schema. Hybrid = rules first, model only when rules miss the equipment or the origin. This is the cold path (search creation), so ~50 ms per model call is fine.

**Tech Stack:** Node ≥ 22.6 TypeScript (`node:test`); Python 3.15 venv `ml/.venv` with `gliner2` 2.1.0 + `torch` 2.15.0 + `transformers` 5.22.1 (model `fastino/gliner2-base-v1`, Apache-2.0); Ollama 0.40 with `qwen2.5:1.5b-instruct-q8_0`.

**Spec:** `LLD.md` §6.1, `ml/spikes/GLINER2.md` (spike findings: 10/10 on templates, about half on messy text, forced equipment guess without an "unspecified" label, "LA" ambiguity).

## Global Constraints

- Same TypeScript rules as Day 1: `.ts` import extensions, `import type` for types, no enums/namespaces/parameter properties.
- Extractors return spans only; **all** interpretation (places, states, regions, numbers, defaults, questions) lives in `src/parse/normalize.ts`, so every extractor is judged on equal terms.
- Never guess silently: missing equipment, unknown or ambiguous places, and direction words ("north") produce a question.
- Defaults when not stated: destination anywhere, deadhead 100 mi, no rate floor, destination radius 150 mi.
- Ambiguous place = the same name exists in two or more states with a population ≥ 50,000 each.
- GLiNER2 equipment labels are `van, reefer, flatbed, unspecified`; a label below confidence 0.6 counts as `unspecified`.
- Every model call is logged (model, latency, tokens when known, output) to `ml/parser/calls.jsonl`.
- The engine's hot path is unchanged by this plan.
- Commit after each task; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File structure

```
src/normalize/gazetteer.ts   (modified) export normPlaceName
src/shared/strings.ts        Jaro-Winkler (created here if Day 2A has not run yet)
src/parse/regions.ts         states, regions, direction and "anywhere" words
src/parse/places.ts          place index: exact, alias, fuzzy, ambiguity
src/parse/types.ts           RawFields, ParseResult, Extractor, ModelCall
src/parse/extract.ts         rules extractor + RATE_PATTERNS, DH_PATTERNS
src/parse/normalize.ts       spans -> ParseResult (+ questions), describe()
src/parse/gliner.ts          GLiNER2 service client (Extractor)
src/parse/ollama.ts          Ollama JSON-schema client (Extractor)
src/parse/parse.ts           parseSearch(text, { mode: rules | model | hybrid })
src/parse/cli.ts             try it from the terminal
src/parse/*.test.ts
ml/parser/service.py         GLiNER2 HTTP service (POST /extract)
ml/parser/eval.jsonl         40 labeled examples (15 template, 25 messy)
ml/parser/score.ts           per-field scoring (+ score.test.ts)
ml/parser/eval.ts            runs contenders, writes RESULTS.md and calls.jsonl
```

---

### Task 1: Place index, states and regions

**Files:**
- Modify: `src/normalize/gazetteer.ts` (whole file shown)
- Create: `src/shared/strings.ts` (only if it does not exist yet), `src/parse/regions.ts`, `src/parse/places.ts`
- Test: `src/parse/places.test.ts`

**Interfaces:**
- Consumes: `sim/data/markets.json`, `sim/data/towns.json`, `jaroWinkler`
- Produces:
  - `normPlaceName(s: string): string`
  - `STATES: Record<string, string>` (code → upper-case name), `REGIONS: Record<string, string[]>`, `DIRECTIONS: Set<string>`, `ANYWHERE: Set<string>`, `ANYWHERE_PHRASES: string[]`, `stateCode(token: string): string | null`
  - `type KnownPlace = { city: string; state: string; lat: number; lon: number; pop: number }`
  - `type Resolution = { place: KnownPlace | null; candidates: KnownPlace[]; ambiguous: boolean; via: 'exact' | 'alias' | 'fuzzy' | 'none' }`
  - `type PlaceIndex = { resolve(name: string, state?: string): Resolution }`, `createPlaceIndex(dataDir: string): PlaceIndex`

- [ ] **Step 1: Write the failing test**

`src/parse/places.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaceIndex } from './places.ts';
import { stateCode } from './regions.ts';

const places = createPlaceIndex(join(dirname(fileURLToPath(import.meta.url)), '../../sim/data'));

test('exact, with and without state', () => {
  const r = places.resolve('Fresno', 'CA');
  assert.equal(r.place?.city, 'Fresno');
  assert.equal(r.ambiguous, false);
  assert.equal(places.resolve('MCALLEN').place?.state, 'TX');
});

test('typos resolve by similarity', () => {
  const r = places.resolve('savanah', 'GA');
  assert.equal(r.place?.city, 'Savannah');
  assert.equal(r.via, 'fuzzy');
});

test('aliases', () => {
  assert.equal(places.resolve('LA').place?.city, 'Los Angeles');
  assert.equal(places.resolve('LA').via, 'alias');
});

test('a name used by big places in two states is ambiguous unless the state is given', () => {
  const r = places.resolve('Columbus');
  assert.equal(r.ambiguous, true);
  assert.equal(r.place?.state, 'OH');                       // the largest is the default pick
  assert.ok(r.candidates.some((p) => p.state === 'GA'));
  const ga = places.resolve('Columbus', 'GA');
  assert.equal(ga.place?.state, 'GA');
  assert.equal(ga.ambiguous, false);
});

test('unknown places and state codes', () => {
  assert.equal(places.resolve('Nowhereville').place, null);
  assert.equal(stateCode('tx'), 'TX');
  assert.equal(stateCode('Texas'), 'TX');
  assert.equal(stateCode('Chicago'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/parse/places.test.ts`
Expected: FAIL, `Cannot find module` for `./places.ts`.

- [ ] **Step 3: Implement**

Replace the whole file (only `norm` is renamed and exported):

`src/normalize/gazetteer.ts`:

```ts
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
    if (n.length === 14) for (const [name, p] of byState.get(state) ?? []) if (name.startsWith(n)) return p;
    return null;
  };
}
```

Skip this file if it already exists (Day 2A Task 1 creates the same file):

`src/shared/strings.ts`:

```ts
// Jaro-Winkler string similarity in [0, 1] (1 = identical). Used for town names in dedup and place lookup.
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const am = new Array<boolean>(la).fill(false), bm = new Array<boolean>(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(lb, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < Math.min(4, la, lb) && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}
```

`src/parse/regions.ts`:

```ts
export const STATES: Record<string, string> = {
  AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS', CA: 'CALIFORNIA', CO: 'COLORADO', CT: 'CONNECTICUT', DE: 'DELAWARE',
  DC: 'DISTRICT OF COLUMBIA', FL: 'FLORIDA', GA: 'GEORGIA', HI: 'HAWAII', ID: 'IDAHO', IL: 'ILLINOIS', IN: 'INDIANA', IA: 'IOWA',
  KS: 'KANSAS', KY: 'KENTUCKY', LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND', MA: 'MASSACHUSETTS', MI: 'MICHIGAN', MN: 'MINNESOTA',
  MS: 'MISSISSIPPI', MO: 'MISSOURI', MT: 'MONTANA', NE: 'NEBRASKA', NV: 'NEVADA', NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY', NM: 'NEW MEXICO',
  NY: 'NEW YORK', NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO', OK: 'OKLAHOMA', OR: 'OREGON', PA: 'PENNSYLVANIA', RI: 'RHODE ISLAND',
  SC: 'SOUTH CAROLINA', SD: 'SOUTH DAKOTA', TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH', VT: 'VERMONT', VA: 'VIRGINIA', WA: 'WASHINGTON',
  WV: 'WEST VIRGINIA', WI: 'WISCONSIN', WY: 'WYOMING',
};

// Multi-word regions first, so "west coast" is found before anything shorter.
export const REGIONS: Record<string, string[]> = {
  'WEST COAST': ['CA', 'OR', 'WA'],
  'EAST COAST': ['CT', 'DE', 'FL', 'GA', 'MA', 'MD', 'ME', 'NC', 'NH', 'NJ', 'NY', 'RI', 'SC', 'VA'],
  SOUTHEAST: ['AL', 'FL', 'GA', 'MS', 'NC', 'SC', 'TN'],
  NORTHEAST: ['CT', 'MA', 'ME', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT'],
  MIDWEST: ['IA', 'IL', 'IN', 'MI', 'MN', 'MO', 'OH', 'WI'],
  SOUTHWEST: ['AZ', 'NM', 'OK', 'TX'],
  NORTHWEST: ['ID', 'OR', 'WA'],
};

export const DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'northbound', 'southbound', 'eastbound', 'westbound']);
export const ANYWHERE = new Set(['anywhere', 'any', 'any direction', 'wherever', 'everywhere']);
export const ANYWHERE_PHRASES = ['anywhere', 'any direction', 'wherever', 'everywhere'];   // safe to search for inside a sentence

export function stateCode(token: string): string | null {
  const u = token.trim().toUpperCase();
  if (STATES[u]) return u;
  for (const [code, name] of Object.entries(STATES)) if (name === u) return code;
  return null;
}
```

`src/parse/places.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/parse/places.test.ts src/normalize/normalize.test.ts`
Expected: PASS (5 new tests; the Day 1 normalize tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/normalize/gazetteer.ts src/shared/strings.ts src/parse/regions.ts src/parse/places.ts src/parse/places.test.ts
git commit -m "feat(parse): place index with aliases, typo tolerance and ambiguity; states and regions"
```

---

### Task 2: Rules extractor

**Files:**
- Create: `src/parse/types.ts`, `src/parse/extract.ts`
- Test: `src/parse/extract.test.ts`

**Interfaces:**
- Consumes: `REGIONS`, `ANYWHERE_PHRASES`
- Produces:
  - `type RawFields = { equipment?: Equip | 'unspecified'; originText?: string; destText?: string; destRadiusMi?: number; rateText?: string; deadheadText?: string }`
  - `type FieldName`, `type Source`, `type ParsedDest`, `type ParseResult`, `type ModelCall`, `type Extractor` (see `types.ts` below)
  - `extractRules(text: string): RawFields`, `RATE_PATTERNS: RegExp[]`, `DH_PATTERNS: RegExp[]`, `EQUIP_PATTERNS: [RegExp, Equip][]`

- [ ] **Step 1: Write the failing test**

`src/parse/extract.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRules } from './extract.ts';

const cases: [string, Record<string, unknown>][] = [
  ['FLATBED CHICAGO IL -> TX/OK DH 150 RPM 3.1', { equipment: 'flatbed', originText: 'CHICAGO IL', destText: 'TX/OK', rateText: '3.1', deadheadText: '150' }],
  ['reefer outta fresno 3.40+ no more than 100 deadhead', { equipment: 'reefer', originText: 'fresno', rateText: '3.40', deadheadText: '100' }],
  ['Phoenix, AZ to Milwaukee, WI (within 150 mi), flatbed only, under 100 mi deadhead, min $3.20/mi',
    { equipment: 'flatbed', originText: 'Phoenix AZ', destText: 'Milwaukee, WI', destRadiusMi: 150, rateText: '3.20', deadheadText: '100' }],
  ['need van out of Scottsdale going LA paying at least 2.62 a mile, 50 mile radius', { equipment: 'van', originText: 'Scottsdale', destText: 'LA', rateText: '2.62', deadheadText: '50' }],
  ['got a dry van empty in joliet tmrw, anything to the southeast over $2.80', { equipment: 'van', originText: 'joliet', destText: 'the southeast', rateText: '2.80' }],
  ['53 ft reefer, Laredo, going north, 75mi DH', { equipment: 'reefer', originText: 'Laredo', destText: 'north', deadheadText: '75' }],
  ['need loads out of dallas', { originText: 'dallas' }],
  ['Got a reefer in Lakeland FL, want Northeast, 3.25 minimum', { equipment: 'reefer', originText: 'Lakeland FL', destText: 'northeast', rateText: '3.25' }],
  ['dryvan chicago to atlanta 2.50/mi', { equipment: 'van', originText: 'chicago', destText: 'atlanta', rateText: '2.50' }],
  ['flatbed - Houston TX - DH 100 - RPM 2.95 - anywhere', { equipment: 'flatbed', originText: 'Houston TX', destText: 'anywhere', rateText: '2.95', deadheadText: '100' }],
];

for (const [text, want] of cases) {
  test(`rules: ${text}`, () => {
    assert.deepEqual(extractRules(text), want);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/parse/extract.test.ts`
Expected: FAIL, `Cannot find module` for `./extract.ts`.

- [ ] **Step 3: Implement**

`src/parse/types.ts`:

```ts
import type { Dest, Equip } from '../shared/types.ts';
import type { KnownPlace } from './places.ts';

// What an extractor found: raw text spans, not yet interpreted.
export type RawFields = { equipment?: Equip | 'unspecified'; originText?: string; destText?: string; destRadiusMi?: number; rateText?: string; deadheadText?: string };
export type FieldName = 'equipment' | 'origin' | 'dest' | 'minRpm' | 'deadheadMi';
export type Source = 'rules' | 'model' | 'default';
export type ParsedDest = Dest & { label?: string };
export type ParseResult = {
  equipment: Equip | null; origin: KnownPlace | null; dest: ParsedDest | null; minRpm: number | null; deadheadMi: number;
  questions: string[]; sources: Partial<Record<FieldName, Source>>;
};
export type ModelCall = { model: string; latencyMs: number; promptTokens: number | null; outputTokens: number | null; output: unknown };
export type Extractor = (text: string) => Promise<{ fields: RawFields; call: ModelCall }>;
```

`src/parse/extract.ts`:

```ts
// Rules extractor: finds the structured tokens dispatchers write ("DH 150", "RPM 3.1", "$3.40/mi", "-> TX/OK").
// Returns raw spans only; normalize.ts interprets them.
import type { Equip } from '../shared/types.ts';
import { ANYWHERE_PHRASES, REGIONS } from './regions.ts';
import type { RawFields } from './types.ts';

export const EQUIP_PATTERNS: [RegExp, Equip][] = [
  [/\b(?:reefer|refrigerated)\b/i, 'reefer'],
  [/\b(?:flat ?bed|step ?deck|conestoga)\b/i, 'flatbed'],
  [/\b(?:dry ?van|van)\b/i, 'van'],
];
export const RATE_PATTERNS: RegExp[] = [
  /\brpm\s*\$?(\d+(?:\.\d+)?)/i,
  /\$?(\d+(?:\.\d+)?)\s*(?:\/\s*mi(?:le)?\b|a mile|per mile)/i,
  /(?:\bmin(?:imum)?|\bat least|\bover|\babove|\bpaying|\bpay)\s*\$?(\d+(?:\.\d+)?)/i,
  /\$?(\d+\.\d{1,2})\s*\+/,
  /\$(\d+\.\d{1,2})\b/,
  /\b(\d+\.\d{1,2})\s*min(?:imum)?\b/i,
];
export const DH_PATTERNS: RegExp[] = [
  /\bdh\s*(\d{1,3})\b/i,
  /\b(\d{1,3})\s*(?:mi|miles?)?\s*(?:dh|deadhead)\b/i,
  /\b(\d{1,3})\s*(?:mi|mile|miles)\s*radius\b/i,
  /\bradius\s*(?:of\s*)?(\d{1,3})\b/i,
  /\bdeadhead\s*(?:of|under|max|up to)?\s*(\d{1,3})\b/i,
];
const DEST_SEP = /(?:\s*(?:->|→)\s*|\b(?:heading|headed|going)(?:\s+to)?\s+|\bto\s+)/i;
const DEST_STOP = /\s*(?:\(|,(?!\s*[A-Za-z]{2}\b)|\s(?:van|reefer|flatbed|dry|paying|pay|min|minimum|under|over|dh|rpm|want|need|only)\b|\s?\$|\s\d)/i;
const ORIGIN_PREP = /\b(?:out of|outta|from|empty in|in|near)\s+([a-z][a-z .'-]*?(?:,?\s+[a-z]{2})?)(?=\s*(?:,|$|-|\b(?:going|to|headed|heading|tmrw|tomorrow|today|tonight|want|need|paying|pay|dh|rpm|any|anywhere|van|reefer|flatbed)\b|\d|\$))/i;
const NOISE = /\b(?:need|needs|looking|for|loads?|got|have|a|an|the|empty|only|truck|available|anything|any direction|anywhere)\b|\d+\s*ft\b|[,–-]/gi;

const firstMatch = (patterns: RegExp[], s: string) => { for (const re of patterns) { const m = re.exec(s); if (m) return m; } return null; };

export function extractRules(text: string): RawFields {
  const out: RawFields = {};
  for (const [re, e] of EQUIP_PATTERNS) if (re.test(text)) { out.equipment = e; break; }
  const rate = firstMatch(RATE_PATTERNS, text);
  if (rate && +rate[1] >= 0.5 && +rate[1] <= 15) out.rateText = rate[1];
  const dh = firstMatch(DH_PATTERNS, text);
  if (dh) out.deadheadText = dh[1];
  const radius = /\(within\s+(\d{1,3})\s*mi/i.exec(text);
  if (radius) out.destRadiusMi = Number(radius[1]);

  const sep = DEST_SEP.exec(text);
  const before = sep ? text.slice(0, sep.index) : text;
  if (sep) {
    const rest = text.slice(sep.index + sep[0].length);
    const stop = DEST_STOP.exec(rest);
    const d = (stop ? rest.slice(0, stop.index) : rest).trim().replace(/[,.;]+$/, '');
    if (d) out.destText = d;
  }
  if (out.destText === undefined) {                       // no "to"/"->": look for "anywhere" or a region word
    const lower = text.toLowerCase();
    if (ANYWHERE_PHRASES.some((w) => new RegExp(`\\b${w}\\b`).test(lower))) out.destText = 'anywhere';
    else {
      const region = Object.keys(REGIONS).find((r) => new RegExp(`\\b${r.toLowerCase()}\\b`).test(lower));
      if (region) out.destText = region.toLowerCase();
    }
  }

  const prep = ORIGIN_PREP.exec(before);
  if (prep) out.originText = prep[1].trim();
  else {                                                  // "Phoenix, AZ to …", "VAN DALLAS TX -> …": the place is what's left
    let p = before;
    for (const re of [...RATE_PATTERNS, ...DH_PATTERNS]) p = p.replace(re, ' ');
    for (const [re] of EQUIP_PATTERNS) p = p.replace(new RegExp(re.source, 'gi'), ' ');
    p = p.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (p) out.originText = p;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/parse/extract.test.ts`
Expected: PASS, 10 tests. If one case fails, fix the pattern, not the expected value, unless the expected value is wrong about what the dispatcher meant.

- [ ] **Step 5: Commit**

```bash
git add src/parse/types.ts src/parse/extract.ts src/parse/extract.test.ts
git commit -m "feat(parse): rules extractor for dispatcher shorthand"
```

---

### Task 3: Normalizer (spans → validated search, with questions)

**Files:**
- Create: `src/parse/normalize.ts`
- Test: `src/parse/normalize.test.ts`

**Interfaces:**
- Consumes: `RawFields`, `ParseResult`, `PlaceIndex`, `STATES`, `REGIONS`, `DIRECTIONS`, `ANYWHERE`, `stateCode`, `RATE_PATTERNS`, `DH_PATTERNS`
- Produces:
  - `normalizeFields(raw: RawFields, places: PlaceIndex, from?: Partial<Record<keyof RawFields, 'rules' | 'model'>>): ParseResult`
  - `parseRate(s?: string): number | null`, `parseDeadhead(s?: string): number | null`, `splitCityState(t: string): { city: string; state?: string }`, `describe(r: ParseResult): string`
  - `DEFAULT_DEADHEAD_MI = 100`, `DEFAULT_DEST_RADIUS_MI = 150`

- [ ] **Step 1: Write the failing test**

`src/parse/normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaceIndex } from './places.ts';
import { normalizeFields, describe, splitCityState } from './normalize.ts';

const places = createPlaceIndex(join(dirname(fileURLToPath(import.meta.url)), '../../sim/data'));

test('state codes, numbers and sources', () => {
  const r = normalizeFields({ equipment: 'flatbed', originText: 'CHICAGO IL', destText: 'TX/OK', rateText: '3.1', deadheadText: '150' }, places);
  assert.equal(r.origin?.city, 'Chicago');
  assert.deepEqual(r.dest, { kind: 'states', states: ['OK', 'TX'] });
  assert.equal(r.minRpm, 3.1);
  assert.equal(r.deadheadMi, 150);
  assert.deepEqual(r.questions, []);
  assert.equal(r.sources.minRpm, 'rules');
});

test('regions, cities with radius, and defaults', () => {
  assert.deepEqual(normalizeFields({ equipment: 'van', originText: 'joliet', destText: 'the southeast' }, places).dest,
    { kind: 'states', states: ['AL', 'FL', 'GA', 'MS', 'NC', 'SC', 'TN'] });
  const p = normalizeFields({ equipment: 'van', originText: 'Phoenix AZ', destText: 'Milwaukee, WI', destRadiusMi: 150 }, places);
  assert.equal(p.dest?.kind, 'point');
  assert.equal(p.dest?.label, 'Milwaukee, WI');
  const d = normalizeFields({ equipment: 'van', originText: 'Atlanta GA' }, places);
  assert.deepEqual(d.dest, { kind: 'anywhere' });
  assert.equal(d.sources.dest, 'default');
  assert.equal(d.deadheadMi, 100);
  assert.equal(d.sources.deadheadMi, 'default');
  assert.equal(d.minRpm, null);
});

test('asks instead of guessing', () => {
  const la = normalizeFields({ equipment: 'van', originText: 'Scottsdale', destText: 'LA' }, places);
  assert.deepEqual(la.dest, { kind: 'states', states: ['LA'] });
  assert.match(la.questions.join(' '), /Louisiana or Los Angeles/);
  const north = normalizeFields({ equipment: 'reefer', originText: 'Laredo', destText: 'north' }, places);
  assert.equal(north.dest, null);
  assert.match(north.questions.join(' '), /north/);
  assert.match(normalizeFields({ originText: 'dallas' }, places).questions.join(' '), /equipment/i);
  assert.match(normalizeFields({ equipment: 'unspecified', originText: 'dallas' }, places).questions.join(' '), /equipment/i);
  assert.match(normalizeFields({ equipment: 'van', originText: 'Columbus' }, places).questions.join(' '), /Columbus, OH or Columbus, GA/);
  assert.match(normalizeFields({ equipment: 'van', originText: 'Nowhereville' }, places).questions.join(' '), /Nowhereville/);
});

test('helpers', () => {
  assert.deepEqual(splitCityState('Kansas City MO'), { city: 'Kansas City', state: 'MO' });
  assert.deepEqual(splitCityState('Phoenix, AZ'), { city: 'Phoenix', state: 'AZ' });
  assert.deepEqual(splitCityState('LA'), { city: 'LA' });
  const r = normalizeFields({ equipment: 'reefer', originText: 'fresno', rateText: '3.40', deadheadText: '100' }, places);
  assert.equal(describe(r), 'Reefer · within 100 mi of Fresno, CA → anywhere · ≥ $3.40/mi');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/parse/normalize.test.ts`
Expected: FAIL, `Cannot find module` for `./normalize.ts`.

- [ ] **Step 3: Implement**

`src/parse/normalize.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/parse/normalize.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/parse/normalize.ts src/parse/normalize.test.ts
git commit -m "feat(parse): normalizer with places, states, regions, defaults and questions"
```

---

### Task 4: Model extractors (GLiNER2 service, Ollama) and parseSearch

**Files:**
- Create: `ml/parser/service.py`, `src/parse/gliner.ts`, `src/parse/ollama.ts`, `src/parse/parse.ts`, `src/parse/cli.ts`
- Test: `src/parse/parse.test.ts`

**Interfaces:**
- Consumes: `Extractor`, `ModelCall`, `RawFields`, `extractRules`, `normalizeFields`, `PlaceIndex`
- Produces:
  - GLiNER2 service: `ml/.venv/bin/python ml/parser/service.py PORT [MODEL]` → `GET /health` → `{ok:true, model}`; `POST /extract {text}` → `{model, result: {entities: {origin_city|destination|rate_per_mile|deadhead_miles: [{text, confidence}]}, equipment: {label, confidence}}}`
  - `createGlinerExtractor(url: string, minConfidence?: number): Extractor`
  - `createOllamaExtractor(opts: { url: string; model: string }): Extractor`
  - `type ParseMode = 'rules' | 'model' | 'hybrid'`
  - `parseSearch(text: string, opts: { places: PlaceIndex; mode: ParseMode; extractor?: Extractor; onModelCall?: (c: ModelCall) => void }): Promise<ParseResult>`

Hybrid calls the model only when rules miss the equipment or the origin, and the model only fills fields the rules left empty.

- [ ] **Step 1: Write the failing test**

`src/parse/parse.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaceIndex } from './places.ts';
import { parseSearch } from './parse.ts';
import type { Extractor, RawFields } from './types.ts';

const places = createPlaceIndex(join(dirname(fileURLToPath(import.meta.url)), '../../sim/data'));
const fake = (fields: RawFields) => {
  let calls = 0;
  const ex: Extractor = async () => { calls++; return { fields, call: { model: 'fake', latencyMs: 1, promptTokens: null, outputTokens: null, output: fields } }; };
  return { ex, calls: () => calls };
};

test('rules mode never calls a model', async () => {
  const r = await parseSearch('need loads out of dallas', { places, mode: 'rules' });
  assert.equal(r.equipment, null);
  assert.equal(r.origin?.city, 'Dallas');
  assert.ok(r.questions.length > 0);
});

test('hybrid calls the model only when rules miss equipment or origin, and only fills gaps', async () => {
  const f = fake({ equipment: 'reefer', originText: 'Somewhere Else' });
  const r = await parseSearch('reefr out of fresno going anywhere', { places, mode: 'hybrid', extractor: f.ex });
  assert.equal(f.calls(), 1);
  assert.equal(r.equipment, 'reefer');
  assert.equal(r.sources.equipment, 'model');
  assert.equal(r.origin?.city, 'Fresno');                    // rules found it; the model doesn't overwrite
  assert.equal(r.sources.origin, 'rules');
  const g = fake({});
  await parseSearch('VAN DALLAS TX -> GA/FL DH 100 RPM 3.05', { places, mode: 'hybrid', extractor: g.ex });
  assert.equal(g.calls(), 0);
});

test('model mode uses only the model, and logs the call', async () => {
  const f = fake({ equipment: 'van', originText: 'Fresno, CA', destText: 'anywhere' });
  const logged: unknown[] = [];
  const r = await parseSearch('whatever', { places, mode: 'model', extractor: f.ex, onModelCall: (c) => logged.push(c) });
  assert.equal(r.origin?.city, 'Fresno');
  assert.equal(r.sources.origin, 'model');
  assert.equal(logged.length, 1);
  await assert.rejects(parseSearch('x', { places, mode: 'model' }), /extractor/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/parse/parse.test.ts`
Expected: FAIL, `Cannot find module` for `./parse.ts`.

- [ ] **Step 3: Implement**

`src/parse/parse.ts`:

```ts
import { extractRules } from './extract.ts';
import { normalizeFields } from './normalize.ts';
import type { PlaceIndex } from './places.ts';
import type { Extractor, ModelCall, ParseResult, RawFields } from './types.ts';

export type ParseMode = 'rules' | 'model' | 'hybrid';

// rules: regex only. model: the model's spans only. hybrid: rules first; the model fills gaps when rules
// miss the equipment or the origin (the two fields a search can't do without).
export async function parseSearch(text: string, opts: { places: PlaceIndex; mode: ParseMode; extractor?: Extractor; onModelCall?: (c: ModelCall) => void }): Promise<ParseResult> {
  const from: Partial<Record<keyof RawFields, 'rules' | 'model'>> = {};
  const fields: RawFields = {};
  if (opts.mode !== 'model') {
    Object.assign(fields, extractRules(text));
    for (const k of Object.keys(fields) as (keyof RawFields)[]) from[k] = 'rules';
  }
  const needModel = opts.mode === 'model' || (opts.mode === 'hybrid' && (!fields.equipment || !fields.originText));
  if (needModel) {
    if (!opts.extractor) throw new Error(`mode "${opts.mode}" needs an extractor`);
    const { fields: m, call } = await opts.extractor(text);
    opts.onModelCall?.(call);
    for (const k of Object.keys(m) as (keyof RawFields)[]) {
      if (fields[k] !== undefined || m[k] === undefined) continue;
      Object.assign(fields, { [k]: m[k] });
      from[k] = 'model';
    }
  }
  return normalizeFields(fields, opts.places, from);
}
```

`src/parse/gliner.ts`:

```ts
// Client for ml/parser/service.py (GLiNER2, local CPU). Cold path only: ~50 ms per call.
import type { Equip } from '../shared/types.ts';
import type { Extractor, RawFields } from './types.ts';

type Span = { text: string; confidence: number };
type GlinerResponse = { model: string; result: { entities: Record<string, Span[] | undefined>; equipment?: { label: string; confidence: number } } };

export function createGlinerExtractor(url: string, minConfidence = 0.6): Extractor {
  return async (text) => {
    const t0 = performance.now();
    const res = await fetch(`${url}/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`gliner service answered ${res.status}`);
    const body = (await res.json()) as GlinerResponse;
    const first = (k: string) => body.result.entities[k]?.[0]?.text;
    const fields: RawFields = {};
    if (first('origin_city')) fields.originText = first('origin_city');
    if (first('destination')) fields.destText = first('destination');
    if (first('rate_per_mile')) fields.rateText = first('rate_per_mile');
    if (first('deadhead_miles')) fields.deadheadText = first('deadhead_miles');
    const eq = body.result.equipment;
    fields.equipment = eq && eq.label !== 'unspecified' && eq.confidence >= minConfidence ? (eq.label as Equip) : 'unspecified';
    return { fields, call: { model: `gliner2:${body.model}`, latencyMs: performance.now() - t0, promptTokens: null, outputTokens: null, output: body.result } };
  };
}
```

`src/parse/ollama.ts`:

```ts
// Local LLM contender: Ollama chat with a JSON schema, so the output always has the right shape.
import type { Extractor, RawFields } from './types.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    equipment: { type: 'string', enum: ['van', 'reefer', 'flatbed', 'unspecified'] },
    origin: { type: ['string', 'null'] },
    destination: { type: ['string', 'null'] },
    min_rate_per_mile: { type: ['number', 'null'] },
    deadhead_miles: { type: ['number', 'null'] },
  },
  required: ['equipment', 'origin', 'destination', 'min_rate_per_mile', 'deadhead_miles'],
};
const SYSTEM = [
  'Extract a truck dispatcher\'s load search.',
  'equipment: van, reefer or flatbed; "unspecified" if not stated (step deck counts as flatbed).',
  'origin: where the empty truck is, copied as written (city and state if given).',
  'destination: copied as written (a city, state codes, a region, or "anywhere"); null if not stated.',
  'min_rate_per_mile: the minimum pay per mile as a number; null if not stated.',
  'deadhead_miles: the radius or deadhead in miles; null if not stated.',
].join('\n');

export function createOllamaExtractor(opts: { url: string; model: string }): Extractor {
  return async (text) => {
    const t0 = performance.now();
    const res = await fetch(`${opts.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, stream: false, format: SCHEMA, options: { temperature: 0 }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }] }) });
    if (!res.ok) throw new Error(`ollama answered ${res.status}`);
    const body = (await res.json()) as { message: { content: string }; prompt_eval_count?: number; eval_count?: number };
    let out: Record<string, unknown> = {};
    try { out = JSON.parse(body.message.content); } catch { out = {}; }
    const fields: RawFields = {};
    if (typeof out.equipment === 'string' && ['van', 'reefer', 'flatbed', 'unspecified'].includes(out.equipment)) fields.equipment = out.equipment as RawFields['equipment'];
    if (typeof out.origin === 'string' && out.origin.trim()) fields.originText = out.origin;
    if (typeof out.destination === 'string' && out.destination.trim()) fields.destText = out.destination;
    if (typeof out.min_rate_per_mile === 'number') fields.rateText = String(out.min_rate_per_mile);
    if (typeof out.deadhead_miles === 'number') fields.deadheadText = String(out.deadhead_miles);
    return { fields, call: { model: `ollama:${opts.model}`, latencyMs: performance.now() - t0, promptTokens: body.prompt_eval_count ?? null, outputTokens: body.eval_count ?? null, output: out } };
  };
}
```

`ml/parser/service.py`:

```python
"""GLiNER2 extraction service for the search parser (cold path).

    ml/.venv/bin/python ml/parser/service.py 7100 [fastino/gliner2-base-v1]

GET /health -> {"ok": true, "model": ...}
POST /extract {"text": ...} -> {"model": ..., "result": {"entities": {...}, "equipment": {"label", "confidence"}}}
Single-threaded on purpose: one model, one request at a time.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from gliner2 import GLiNER2

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7100
MODEL = sys.argv[2] if len(sys.argv) > 2 else "fastino/gliner2-base-v1"
model = GLiNER2.from_pretrained(MODEL)
schema = (
    model.create_schema()
    .entities({
        "origin_city": "city or town where the empty truck is",
        "destination": "destination city, state, region or 'anywhere'",
        "rate_per_mile": "minimum pay in dollars per mile",
        "deadhead_miles": "radius or deadhead distance in miles",
    })
    .classification("equipment", ["van", "reefer", "flatbed", "unspecified"])
)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True, "model": MODEL}) if self.path == "/health" else self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/extract":
            self._send(404, {"error": "not_found"})
            return
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self._send(200, {"model": MODEL, "result": model.extract(body["text"], schema, include_confidence=True)})

    def log_message(self, *args):
        pass


print(f"gliner2 service ready on :{PORT} ({MODEL})", flush=True)
HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
```

`src/parse/cli.ts`:

```ts
// Try the parser from the terminal:
//   node src/parse/cli.ts "reefer outta fresno 3.40+ no more than 100 deadhead"
//   node src/parse/cli.ts --mode hybrid --gliner http://127.0.0.1:7100 "need loads out of dallas"
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPlaceIndex } from './places.ts';
import { parseSearch, type ParseMode } from './parse.ts';
import { createGlinerExtractor } from './gliner.ts';
import { createOllamaExtractor } from './ollama.ts';
import { describe } from './normalize.ts';

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
  mode: { type: 'string', default: 'rules' }, gliner: { type: 'string', default: '' }, ollama: { type: 'string', default: '' },
  'ollama-model': { type: 'string', default: 'qwen2.5:1.5b-instruct-q8_0' } } });
const places = createPlaceIndex(join(dirname(fileURLToPath(import.meta.url)), '../../sim/data'));
const extractor = a.gliner ? createGlinerExtractor(a.gliner) : a.ollama ? createOllamaExtractor({ url: a.ollama, model: a['ollama-model']! }) : undefined;
const r = await parseSearch(positionals.join(' '), { places, mode: a.mode as ParseMode, extractor });
console.log(describe(r));
for (const q of r.questions) console.log(`? ${q}`);
console.log(JSON.stringify(r.sources));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/parse/parse.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Smoke-test the service and the CLI**

```bash
ml/.venv/bin/python ml/parser/service.py 7100 &
sleep 60   # first start loads the model
curl -s localhost:7100/health
node src/parse/cli.ts --mode hybrid --gliner http://127.0.0.1:7100 "reefr out of fresno going anywhere"
node src/parse/cli.ts "FLATBED CHICAGO IL -> TX/OK DH 150 RPM 3.1"
```

Expected: `{"ok": true, ...}`; then `Reefer · within 100 mi of Fresno, CA → anywhere · any rate` with `"equipment":"model"` in the sources line; then `Flatbed · within 150 mi of Chicago, IL → OK/TX · ≥ $3.10/mi`. Leave the service running for Task 5.

- [ ] **Step 6: Commit**

```bash
git add ml/parser/service.py src/parse/gliner.ts src/parse/ollama.ts src/parse/parse.ts src/parse/cli.ts src/parse/parse.test.ts
git commit -m "feat(parse): GLiNER2 service and Ollama extractors; parseSearch with rules/model/hybrid modes"
```

---

### Task 5: Eval set, scoring and the model comparison

**Files:**
- Create: `ml/parser/eval.jsonl`, `ml/parser/score.ts`, `ml/parser/eval.ts`
- Test: `ml/parser/score.test.ts`
- Generated and committed: `ml/parser/RESULTS.md`, `ml/parser/calls.jsonl`
- Modify: `LLD.md` §6.1, `DESIGN.md` §8, `README.md` (Focus section)

**Interfaces:**
- Consumes: `parseSearch`, `createPlaceIndex`, `createGlinerExtractor`, `createOllamaExtractor`, `ParseResult`, `ParsedDest`
- Produces:
  - `type EvalExample = { text: string; kind: 'template' | 'messy'; equipment: Equip | null; origin: string | null; dest: string; minRpm: number | null; deadheadMi: number; ask: boolean }` where `dest` is `anywhere`, `states:AA,BB` (sorted), `point:City, ST`, or `?` (should be left empty and asked)
  - `destKey(d: ParsedDest | null): string`, `scoreExample(e: EvalExample, r: ParseResult): Record<'equipment' | 'origin' | 'dest' | 'minRpm' | 'deadheadMi' | 'ask' | 'all', boolean>`
  - `node ml/parser/eval.ts --contenders rules,gliner,hybrid,qwen [--gliner URL] [--ollama URL]` → `ml/parser/RESULTS.md`, appends `ml/parser/calls.jsonl`

- [ ] **Step 1: Write the eval set**

`ml/parser/eval.jsonl` (40 lines; expected answers follow the Global Constraints defaults):

```
{"kind":"template","text":"need van out of Scottsdale going LA paying at least 2.62 a mile, 50 mile radius","equipment":"van","origin":"Scottsdale, AZ","dest":"states:LA","minRpm":2.62,"deadheadMi":50,"ask":true}
{"kind":"template","text":"Phoenix, AZ to anywhere, van only, under 75 mi deadhead, min $3.47/mi","equipment":"van","origin":"Phoenix, AZ","dest":"anywhere","minRpm":3.47,"deadheadMi":75,"ask":false}
{"kind":"template","text":"Phoenix, AZ to Milwaukee, WI (within 150 mi), flatbed only, under 100 mi deadhead, min $3.20/mi","equipment":"flatbed","origin":"Phoenix, AZ","dest":"point:Milwaukee, WI","minRpm":3.2,"deadheadMi":100,"ask":false}
{"kind":"template","text":"Allentown, PA to anywhere, flatbed only, under 100 mi deadhead, min $3.52/mi","equipment":"flatbed","origin":"Allentown, PA","dest":"anywhere","minRpm":3.52,"deadheadMi":100,"ask":false}
{"kind":"template","text":"Birmingham, AL to Miami, FL (within 200 mi), van only, under 150 mi deadhead, min $3.16/mi","equipment":"van","origin":"Birmingham, AL","dest":"point:Miami, FL","minRpm":3.16,"deadheadMi":150,"ask":false}
{"kind":"template","text":"Birmingham, AL to CO, flatbed only, under 75 mi deadhead, min $4.16/mi","equipment":"flatbed","origin":"Birmingham, AL","dest":"states:CO","minRpm":4.16,"deadheadMi":75,"ask":false}
{"kind":"template","text":"Omaha, NE to Charleston, SC (within 200 mi), reefer only, under 100 mi deadhead, min $3.32/mi","equipment":"reefer","origin":"Omaha, NE","dest":"point:Charleston, SC","minRpm":3.32,"deadheadMi":100,"ask":false}
{"kind":"template","text":"need reefer out of Cincinnati going anywhere paying at least 3.58 a mile, 75 mile radius","equipment":"reefer","origin":"Cincinnati, OH","dest":"anywhere","minRpm":3.58,"deadheadMi":75,"ask":false}
{"kind":"template","text":"VAN DALLAS TX -> GA/FL DH 100 RPM 3.05","equipment":"van","origin":"Dallas, TX","dest":"states:FL,GA","minRpm":3.05,"deadheadMi":100,"ask":false}
{"kind":"template","text":"REEFER FRESNO CA -> ANYWHERE DH 150 RPM 3.7","equipment":"reefer","origin":"Fresno, CA","dest":"anywhere","minRpm":3.7,"deadheadMi":150,"ask":false}
{"kind":"template","text":"need flatbed out of Memphis going TN/AR/MS, 100 mile radius","equipment":"flatbed","origin":"Memphis, TN","dest":"states:AR,MS,TN","minRpm":null,"deadheadMi":100,"ask":false}
{"kind":"template","text":"Nashville, TN to Chicago, IL (within 100 mi), reefer only, under 50 mi deadhead","equipment":"reefer","origin":"Nashville, TN","dest":"point:Chicago, IL","minRpm":null,"deadheadMi":50,"ask":false}
{"kind":"template","text":"FLATBED HARRISBURG PA -> OH DH 75","equipment":"flatbed","origin":"Harrisburg, PA","dest":"states:OH","minRpm":null,"deadheadMi":75,"ask":false}
{"kind":"template","text":"need van out of Stockton going anywhere, 150 mile radius","equipment":"van","origin":"Stockton, CA","dest":"anywhere","minRpm":null,"deadheadMi":150,"ask":false}
{"kind":"template","text":"Laredo, TX to anywhere, van only, under 100 mi deadhead, min $2.90/mi","equipment":"van","origin":"Laredo, TX","dest":"anywhere","minRpm":2.9,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"FLATBED CHICAGO IL -> TX/OK DH 150 RPM 3.1","equipment":"flatbed","origin":"Chicago, IL","dest":"states:OK,TX","minRpm":3.1,"deadheadMi":150,"ask":false}
{"kind":"messy","text":"reefer outta fresno 3.40+ no more than 100 deadhead","equipment":"reefer","origin":"Fresno, CA","dest":"anywhere","minRpm":3.4,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"got a dry van empty in joliet tmrw, anything to the southeast over $2.80","equipment":"van","origin":"Joliet, IL","dest":"states:AL,FL,GA,MS,NC,SC,TN","minRpm":2.8,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"stepdeck near savanah ga, want 4/mi or better","equipment":"flatbed","origin":"Savannah, GA","dest":"anywhere","minRpm":4,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"53 ft reefer, Laredo, going north, 75mi DH","equipment":"reefer","origin":"Laredo, TX","dest":"?","minRpm":null,"deadheadMi":75,"ask":true}
{"kind":"messy","text":"need loads out of dallas","equipment":null,"origin":"Dallas, TX","dest":"anywhere","minRpm":null,"deadheadMi":100,"ask":true}
{"kind":"messy","text":"Dry van in Atlanta GA headed to Charlotte NC, min 2.75/mi, 50 mi DH","equipment":"van","origin":"Atlanta, GA","dest":"point:Charlotte, NC","minRpm":2.75,"deadheadMi":50,"ask":false}
{"kind":"messy","text":"reefer from Salinas CA to the northeast paying 3.90 a mile","equipment":"reefer","origin":"Salinas, CA","dest":"states:CT,MA,ME,NH,NJ,NY,PA,RI,VT","minRpm":3.9,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"Flatbed out of Columbus, need 3.25+ to anywhere","equipment":"flatbed","origin":"Columbus, OH","dest":"anywhere","minRpm":3.25,"deadheadMi":100,"ask":true}
{"kind":"messy","text":"van empty in ontario ca any direction","equipment":"van","origin":"Ontario, CA","dest":"anywhere","minRpm":null,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"REEFER MCALLEN TX -> IL/IN/OH RPM 3.4 DH 50","equipment":"reefer","origin":"McAllen, TX","dest":"states:IL,IN,OH","minRpm":3.4,"deadheadMi":50,"ask":false}
{"kind":"messy","text":"need a flat bed outta Birmingham AL heading to Texas","equipment":"flatbed","origin":"Birmingham, AL","dest":"states:TX","minRpm":null,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"van, Kansas City MO, going west coast, $3/mi","equipment":"van","origin":"Kansas City, MO","dest":"states:CA,OR,WA","minRpm":3,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"reefr out of fresno going anywhere","equipment":"reefer","origin":"Fresno, CA","dest":"anywhere","minRpm":null,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"dryvan chicago to atlanta 2.50/mi","equipment":"van","origin":"Chicago, IL","dest":"point:Atlanta, GA","minRpm":2.5,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"looking for loads Indianapolis to Nashville van","equipment":"van","origin":"Indianapolis, IN","dest":"point:Nashville, TN","minRpm":null,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"Flatbed near Denver CO, 100 mi radius, 3.50 per mile","equipment":"flatbed","origin":"Denver, CO","dest":"anywhere","minRpm":3.5,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"reefer Yakima WA to Seattle WA","equipment":"reefer","origin":"Yakima, WA","dest":"point:Seattle, WA","minRpm":null,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"van out of Greenville SC anywhere but NY","equipment":"van","origin":"Greenville, SC","dest":"?","minRpm":null,"deadheadMi":100,"ask":true}
{"kind":"messy","text":"Got a reefer in Lakeland FL, want Northeast, 3.25 minimum","equipment":"reefer","origin":"Lakeland, FL","dest":"states:CT,MA,ME,NH,NJ,NY,PA,RI,VT","minRpm":3.25,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"flatbed - Houston TX - DH 100 - RPM 2.95 - anywhere","equipment":"flatbed","origin":"Houston, TX","dest":"anywhere","minRpm":2.95,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"VAN ATLANTA","equipment":"van","origin":"Atlanta, GA","dest":"anywhere","minRpm":null,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"LA to Phoenix reefer","equipment":"reefer","origin":"Los Angeles, CA","dest":"point:Phoenix, AZ","minRpm":null,"deadheadMi":100,"ask":false}
{"kind":"messy","text":"flatbed in Gary IN going to Detroit 3.60/mi 150 dh","equipment":"flatbed","origin":"Gary, IN","dest":"point:Detroit, MI","minRpm":3.6,"deadheadMi":150,"ask":false}
{"kind":"messy","text":"van chicago","equipment":"van","origin":"Chicago, IL","dest":"anywhere","minRpm":null,"deadheadMi":100,"ask":false}
```

`van out of Greenville SC anywhere but NY` is deliberately unsupported (exclusions): the right answer is to ask. Expect every contender to miss it, and keep it in the set anyway.

- [ ] **Step 2: Write the failing scoring test**

`ml/parser/score.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreExample, destKey, type EvalExample } from './score.ts';
import type { ParseResult } from '../../src/parse/types.ts';

const result = (o: Partial<ParseResult> = {}): ParseResult => ({ equipment: 'van', origin: { city: 'St. Louis', state: 'MO', lat: 0, lon: 0, pop: 1 },
  dest: { kind: 'states', states: ['TX', 'OK'] }, minRpm: 3.1, deadheadMi: 100, questions: [], sources: {}, ...o });
const ex = (o: Partial<EvalExample> = {}): EvalExample => ({ text: 't', kind: 'messy', equipment: 'van', origin: 'St Louis, MO', dest: 'states:OK,TX', minRpm: 3.1, deadheadMi: 100, ask: false, ...o });

test('scores each field, ignoring punctuation and order', () => {
  const s = scoreExample(ex(), result());
  assert.deepEqual(s, { equipment: true, origin: true, dest: true, minRpm: true, deadheadMi: true, ask: true, all: true });
  const t = scoreExample(ex({ minRpm: null, ask: true }), result());
  assert.equal(t.minRpm, false);
  assert.equal(t.ask, false);
  assert.equal(t.all, false);
});

test('destination keys', () => {
  assert.equal(destKey(null), '?');
  assert.equal(destKey({ kind: 'anywhere' }), 'anywhere');
  assert.equal(destKey({ kind: 'point', lat: 0, lon: 0, radiusMi: 150, label: 'Milwaukee, WI' }), 'point:MILWAUKEE, WI');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test ml/parser/score.test.ts`
Expected: FAIL, `Cannot find module` for `./score.ts`.

- [ ] **Step 4: Implement scoring and the harness**

`ml/parser/score.ts`:

```ts
import type { Equip } from '../../src/shared/types.ts';
import type { ParseResult, ParsedDest } from '../../src/parse/types.ts';

export type EvalExample = { text: string; kind: 'template' | 'messy'; equipment: Equip | null; origin: string | null; dest: string; minRpm: number | null; deadheadMi: number; ask: boolean };
export const FIELDS = ['equipment', 'origin', 'dest', 'minRpm', 'deadheadMi', 'ask'] as const;

const name = (s: string) => s.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

export function destKey(d: ParsedDest | null): string {
  if (!d) return '?';
  if (d.kind === 'anywhere') return 'anywhere';
  if (d.kind === 'states') return `states:${[...d.states].sort().join(',')}`;
  return `point:${name(d.label ?? '')}`;
}

export function scoreExample(e: EvalExample, r: ParseResult): Record<(typeof FIELDS)[number] | 'all', boolean> {
  const want = e.dest.startsWith('point:') ? `point:${name(e.dest.slice(6))}` : e.dest;
  const s = {
    equipment: r.equipment === e.equipment,
    origin: (r.origin ? name(`${r.origin.city}, ${r.origin.state}`) : null) === (e.origin ? name(e.origin) : null),
    dest: destKey(r.dest) === want,
    minRpm: e.minRpm === null ? r.minRpm === null : r.minRpm !== null && Math.abs(r.minRpm - e.minRpm) < 0.005,
    deadheadMi: r.deadheadMi === e.deadheadMi,
    ask: (r.questions.length > 0) === e.ask,
  };
  return { ...s, all: Object.values(s).every(Boolean) };
}
```

`ml/parser/eval.ts`:

```ts
// Compares search-parser contenders on ml/parser/eval.jsonl. Writes RESULTS.md and logs every model call.
//   ml/.venv/bin/python ml/parser/service.py 7100 &      (for gliner / hybrid)
//   node ml/parser/eval.ts --contenders rules,gliner,hybrid,qwen
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPlaceIndex } from '../../src/parse/places.ts';
import { parseSearch, type ParseMode } from '../../src/parse/parse.ts';
import { createGlinerExtractor } from '../../src/parse/gliner.ts';
import { createOllamaExtractor } from '../../src/parse/ollama.ts';
import type { Extractor, ModelCall } from '../../src/parse/types.ts';
import { FIELDS, scoreExample, type EvalExample } from './score.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: {
  contenders: { type: 'string', default: 'rules,gliner,hybrid,qwen' }, gliner: { type: 'string', default: 'http://127.0.0.1:7100' },
  ollama: { type: 'string', default: 'http://127.0.0.1:11434' }, 'ollama-model': { type: 'string', default: 'qwen2.5:1.5b-instruct-q8_0' } } });
const examples: EvalExample[] = readFileSync(join(here, 'eval.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const places = createPlaceIndex(join(here, '../../sim/data'));
const gliner = createGlinerExtractor(a.gliner!);
const qwen = createOllamaExtractor({ url: a.ollama!, model: a['ollama-model']! });
const CONTENDERS: Record<string, { mode: ParseMode; extractor?: Extractor; label: string }> = {
  rules: { mode: 'rules', label: 'Rules only' },
  gliner: { mode: 'model', extractor: gliner, label: 'GLiNER2 only' },
  hybrid: { mode: 'hybrid', extractor: gliner, label: 'Hybrid: rules + GLiNER2' },
  qwen: { mode: 'model', extractor: qwen, label: `Qwen 2.5 1.5B only (Ollama, JSON schema)` },
  'hybrid-qwen': { mode: 'hybrid', extractor: qwen, label: 'Hybrid: rules + Qwen' },
};
const callsFile = join(here, 'calls.jsonl');
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const q = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

const rows: string[] = [];
const failures: string[] = [];
for (const key of a.contenders!.split(',')) {
  const c = CONTENDERS[key];
  if (!c) throw new Error(`unknown contender ${key}`);
  if (c.extractor) await c.extractor('warm up');              // first call loads the model; not measured
  const ok: Record<string, number> = Object.fromEntries([...FIELDS, 'all', 'messyAll'].map((f) => [f, 0]));
  const latency: number[] = [];
  let calls = 0, tokens = 0;
  for (const e of examples) {
    const t0 = performance.now();
    const r = await parseSearch(e.text, { places, mode: c.mode, extractor: c.extractor, onModelCall: (m: ModelCall) => {
      calls++;
      tokens += (m.promptTokens ?? 0) + (m.outputTokens ?? 0);
      appendFileSync(callsFile, JSON.stringify({ ts: new Date().toISOString(), contender: key, text: e.text, ...m }) + '\n');
    } });
    latency.push(performance.now() - t0);
    const s = scoreExample(e, r);
    for (const f of [...FIELDS, 'all'] as const) if (s[f]) ok[f]++;
    if (s.all && e.kind === 'messy') ok.messyAll++;
    if (!s.all && key === 'hybrid') failures.push(`- \`${e.text}\` — wrong: ${FIELDS.filter((f) => !s[f]).join(', ')}`);
  }
  const n = examples.length, messy = examples.filter((e) => e.kind === 'messy').length;
  rows.push(`| ${c.label} | ${FIELDS.map((f) => pct(ok[f], n)).join(' | ')} | **${pct(ok.all, n)}** | ${pct(ok.messyAll, messy)} | ${calls} | ${q(latency, 0.5).toFixed(1)} / ${q(latency, 0.95).toFixed(1)} ms | ${tokens || '—'} |`);
  console.log(rows[rows.length - 1]);
}

writeFileSync(join(here, 'RESULTS.md'), `# Search parser: results

Generated by \`node ml/parser/eval.ts --contenders ${a.contenders}\` on ${new Date().toISOString().slice(0, 10)}, on a MacBook CPU.
Eval set: \`eval.jsonl\`, ${examples.length} searches (${examples.filter((e) => e.kind === 'template').length} generator templates, ${examples.filter((e) => e.kind === 'messy').length} hand-written messy ones).
Every model call is logged in \`calls.jsonl\` (model, latency, tokens when known, raw output).

A field counts as correct only after normalization (places, states, regions, numbers, defaults). "Asks when unsure" means the parser asked a question exactly when the example expects one.

| Contender | Equipment | Origin | Destination | Rate floor | Deadhead | Asks when unsure | All correct | All correct (messy) | Model calls | Latency p50 / p95 | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Where the hybrid parser is still wrong

${failures.join('\n') || 'Nothing: every example correct.'}
`);
```

- [ ] **Step 5: Run the scoring test**

If `package.json`'s `test` script does not include `"ml/**/*.test.ts"` yet (Day 2A Task 2 adds it), set it to:

```json
    "test": "node --test \"src/**/*.test.ts\" \"sims/**/*.test.ts\" \"scorer/**/*.test.ts\" \"ml/**/*.test.ts\"",
```


Run: `node --test ml/parser/score.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the comparison**

With the GLiNER2 service from Task 4 still running and Ollama up (`ollama list` shows `qwen2.5:1.5b-instruct-q8_0`):

Run: `node ml/parser/eval.ts --contenders rules,gliner,hybrid,qwen,hybrid-qwen`
Expected: one table row per contender, and `ml/parser/RESULTS.md` written. Read it: the choice for production is the cheapest contender within a few points of the best "All correct" score. Record that choice and the reason in the next step, whatever the numbers say.

- [ ] **Step 7: Update the docs**

In `LLD.md`, replace everything from the line `### 6.1 Search parser` up to (not including) the line `### 6.2 Planner` with:

````markdown
### 6.1 Search parser

Code: `src/parse/`. Measured comparison: `ml/parser/RESULTS.md`.

```
extract spans:   rules (regex)  ──► model only if rules miss equipment or origin (GLiNER2 service, or Qwen via Ollama)
normalize:       places (exact, alias, typo, ambiguity) · states · regions · numbers · defaults
questions:       missing equipment, unknown or ambiguous places, directions ("north"), "LA" (Louisiana or Los Angeles?)
confirm:         "Reefer · within 100 mi of Fresno, CA → anywhere · ≥ $3.40/mi"
```

- **Extractors find spans; one normalizer interprets them,** so rules, GLiNER2 and an LLM are compared on equal terms.
- **Never guess silently.** A forced-choice model always answers (the spike classified "need loads out of dallas" as flatbed); an `unspecified` label plus a 0.6 confidence threshold turns that into a question.
- **Defaults:** destination anywhere, deadhead 100 mi, no rate floor, destination radius 150 mi.
- **Ambiguous place:** the same name in two or more states with population ≥ 50,000 each (Columbus OH/GA, Kansas City MO/KS).
- **Observability:** every model call is logged with model, latency, tokens (when the model reports them) and raw output.
- **Not supported yet:** exclusions ("anywhere but NY") and multi-stop searches; the eval set keeps an example of each so the gap stays visible.
````

In `DESIGN.md` §8, change the search-parser checkbox to `- [x]` and append ` (results: ml/parser/RESULTS.md)`.

In `README.md`, in the "Focus" section, replace the **LLM: search parser** bullet with:

```markdown
- **Search parser: rules + a small model.** Rules handle dispatcher shorthand; a small local model (GLiNER2, or Qwen via Ollama) fills what the rules miss; one normalizer resolves places, regions and typos and asks instead of guessing. Contenders compared on one eval set: [ml/parser/RESULTS.md](ml/parser/RESULTS.md).
```

- [ ] **Step 8: Run all tests and commit**

```bash
npm test
git add package.json ml/parser/eval.jsonl ml/parser/score.ts ml/parser/score.test.ts ml/parser/eval.ts ml/parser/RESULTS.md ml/parser/calls.jsonl LLD.md DESIGN.md README.md
git commit -m "feat(ml): parser eval set and contender comparison (rules, GLiNER2, hybrid, Qwen) with call log"
```
