# Load Radar Day 2A: Same-Load Dedup Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written same-load rule in dedup with a classifier trained on the generator's answer key, compare it offline with the rule and with LightGBM, and measure its effect on missed and duplicate alerts end to end.

**Architecture:** One TypeScript function computes pair features (`src/dedup/features.ts`); the same function produces the training data (`ml/dedup/export_pairs.ts`) and runs at inference time, so training and serving can't drift apart. Python (scikit-learn, LightGBM) trains offline and writes `ml/dedup/model.json` (logistic-regression weights + scaler + threshold + parity samples). The engine loads that JSON and scores pairs in plain TypeScript, microseconds per pair, no Python at runtime.

**Tech Stack:** Node ≥ 22.6 (TypeScript via type stripping, `node:test`), Python 3.15 venv at `ml/.venv` with scikit-learn 1.9.1, LightGBM 4.7.0, numpy.

**Spec:** `DESIGN.md` §4 row 6 and §3.3 (dedup), `LLD.md` §6.6, the Day 1 end-to-end result in `README.md` (duplicates 2.2%, target < 1%).

## Global Constraints

> **Owner decision (2026-11-04): no automated tests.** Skip every step that writes or runs a `*.test.ts` file. Check each task instead with the commands it already lists for real data: the CLI, the training script output, `ml/dedup/compare.ts`, `ml/parser/eval.ts`, and scored runs with `node scripts/run.ts`.

- Same rules as Day 1: every relative import ends in `.ts`; type-only imports use `import type`; no enums, namespaces or parameter properties.
- Training/serving parity: features come only from `pairFeatures()` in `src/dedup/features.ts`. Python never computes features.
- Splits are **by time** (first 60% of pairs train, next 20% pick the threshold, last 20% test). Never random: random splits leak the future.
- Threshold rule: the highest-recall threshold whose **precision ≥ 0.995** on the validation split. A wrong merge hides a real load; a duplicate is only noise.
- The rule stays the default (`--dedup-model` unset). The model is opt-in until its end-to-end numbers are better.
- Training data comes from a separate seed (`--seed 11`) from the evaluation data (`--seed 1`).
- Generated data and pair files are not committed (`ml/dedup/data/`, `out-eval/`); `ml/dedup/model.json` and `ml/dedup/RESULTS.md` are.
- Commit after each task; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File structure

```
src/shared/strings.ts          Jaro-Winkler similarity
src/dedup/features.ts          PairSide, sideOf(load), FEATURE_NAMES, pairFeatures()
src/dedup/dedup.ts             (modified) pluggable sameLoad; rule exported as sameLoadRule
src/dedup/classifier.ts        createClassifier(model) / loadClassifier(file): logistic scoring from model.json
src/dedup/features.test.ts, src/dedup/classifier.test.ts
ml/requirements.txt            pinned Python dependencies
ml/dedup/export_pairs.ts       postings + answer key -> labeled pair CSV (+ export.test.ts)
ml/dedup/train.py              rule vs logistic vs LightGBM; writes model.json
ml/dedup/compare.ts            end-to-end runs: rule vs model -> RESULTS.md
src/engine.ts, scripts/run.ts  (modified) --dedup-model flag
```

---

### Task 1: Pair features and a pluggable dedup decision

**Files:**
- Create: `src/shared/strings.ts`, `src/dedup/features.ts`
- Modify: `src/dedup/dedup.ts` (whole file shown)
- Test: `src/dedup/features.test.ts` (existing `src/dedup/dedup.test.ts` must still pass unchanged)

**Interfaces:**
- Produces:
  - `jaroWinkler(a: string, b: string): number`
  - `type PairSide = { rate: number | null; brokerMc: string; postedAt: number; board: string; originCity: string; destCity: string; originLat: number; originLon: number; destLat: number; destLon: number; miles: number; equipmentDetail: string }`
  - `sideOf(l: Load): PairSide`, `FEATURE_NAMES` (12 names), `pairFeatures(candidate: PairSide, posting: PairSide): number[]`
  - `type SameLoad = (candidate: PairSide, posting: PairSide) => boolean`, `sameLoadRule: SameLoad`, `createDedup(clock: Clock, sameLoad?: SameLoad)`

- [ ] **Step 1: Write the failing test**

`src/dedup/features.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaroWinkler } from '../shared/strings.ts';
import { pairFeatures, FEATURE_NAMES, type PairSide } from './features.ts';
import { createDedup } from './dedup.ts';
import { createFakeClock } from '../shared/clock.ts';
import type { Load } from '../shared/types.ts';

test('jaroWinkler matches textbook values', () => {
  assert.equal(jaroWinkler('MARTHA', 'MARTHA'), 1);
  assert.ok(Math.abs(jaroWinkler('MARTHA', 'MARHTA') - 0.9611) < 0.001);
  assert.ok(Math.abs(jaroWinkler('DIXON', 'DICKSONX') - 0.8133) < 0.001);
  assert.equal(jaroWinkler('ABC', ''), 0);
});

const side = (o: Partial<PairSide> = {}): PairSide => ({ rate: 2000, brokerMc: '1', postedAt: 0, board: 'dat', originCity: 'CHICAGO', destCity: 'ATLANTA',
  originLat: 41.88, originLon: -87.63, destLat: 33.75, destLon: -84.39, miles: 716, equipmentDetail: 'V', ...o });

test('pair features', () => {
  const f = pairFeatures(side(), side({ rate: 1800, brokerMc: '2', postedAt: 1_800_000, board: 'truckstop', originCity: 'CHICAGO HEIGHTS' }));
  assert.equal(f.length, FEATURE_NAMES.length);
  const by = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, f[i]]));
  assert.equal(by.rate_rel_diff, 0.1);
  assert.equal(by.rate_missing, 0);
  assert.equal(by.rate_ratio, 0.9);
  assert.equal(by.same_broker, 0);
  assert.equal(by.dt_hours, 0.5);
  assert.equal(by.same_board, 0);
  assert.ok(by.origin_name_sim > 0.85 && by.origin_name_sim < 1);
  assert.equal(by.dest_name_sim, 1);
  assert.equal(by.origin_miles, 0);
  const g = pairFeatures(side({ rate: null }), side());
  assert.deepEqual([g[0], g[1], g[2]], [0, 1, 1]);
});

test('dedup uses the decision function it is given', () => {
  const T0 = Date.parse('2026-11-04T15:00:00Z');
  const load = (key: string, brokerMc: string): Load => ({ key, board: 'dat', boardLoadId: key, brokerMc,
    origin: { city: 'Chicago', state: 'IL', lat: 41.88, lon: -87.63, cell4: 'dp3w' }, dest: { city: 'Atlanta', state: 'GA', lat: 33.75, lon: -84.39, cell4: 'dn5b' },
    equipment: 'van', equipmentDetail: 'V', rate: 1950, miles: 716, pickupDate: '2026-11-04', postedAt: T0, contentHash: key, visibleTo: { kind: 'all' }, canonicalId: '' });
  const always = createDedup(createFakeClock(T0), () => true);
  always(load('a', '1'));
  assert.equal(always(load('b', '2')).result, 'merged');
  const never = createDedup(createFakeClock(T0), () => false);
  never(load('a', '1'));
  assert.equal(never(load('b', '1')).result, 'new');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/dedup/features.test.ts`
Expected: FAIL, `Cannot find module` for `../shared/strings.ts`.

- [ ] **Step 3: Implement**

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

`src/dedup/features.ts`:

```ts
// Pair features for the same-load decision. The ONLY place features are computed: training data
// (ml/dedup/export_pairs.ts) and the engine both call pairFeatures(), so they cannot drift apart.
import { milesBetween } from '../shared/geo.ts';
import { jaroWinkler } from '../shared/strings.ts';
import type { Load } from '../shared/types.ts';

export type PairSide = {
  rate: number | null; brokerMc: string; postedAt: number; board: string;
  originCity: string; destCity: string; originLat: number; originLon: number; destLat: number; destLon: number;
  miles: number; equipmentDetail: string;
};

export const sideOf = (l: Load): PairSide => ({
  rate: l.rate, brokerMc: l.brokerMc, postedAt: l.postedAt, board: l.board,
  originCity: l.origin.city.toUpperCase(), destCity: l.dest.city.toUpperCase(),
  originLat: l.origin.lat, originLon: l.origin.lon, destLat: l.dest.lat, destLon: l.dest.lon,
  miles: l.miles, equipmentDetail: l.equipmentDetail.toUpperCase(),
});

export const FEATURE_NAMES = [
  'rate_rel_diff', 'rate_missing', 'rate_ratio', 'same_broker', 'dt_hours', 'same_board',
  'origin_name_sim', 'dest_name_sim', 'origin_miles', 'dest_miles', 'miles_rel_diff', 'same_equipment_detail',
] as const;

export function pairFeatures(c: PairSide, l: PairSide): number[] {
  const missing = c.rate === null || l.rate === null;
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
  ];
}
```

Replace the whole file:

`src/dedup/dedup.ts`:

```ts
import type { Clock } from '../shared/clock.ts';
import { createExpiringMap } from '../shared/expiring.ts';
import { neighborCells } from '../shared/geo.ts';
import type { Load } from '../shared/types.ts';
import { sideOf, type PairSide } from './features.ts';

type Seen = { hash: string; canonicalId: string };
type Entry = PairSide & { canonicalId: string };
export type DedupResult = { result: 'refresh' | 'updated' | 'merged' | 'new'; canonicalId: string; candidates: number };
export type SameLoad = (candidate: PairSide, posting: PairSide) => boolean;

const HOUR = 3_600_000;
const TTL = 72 * HOUR;

// The Day 1 rule (LLD 6.6), kept as the baseline and the default. Same broker: rate within 13% and 6 h.
// Different broker: a co-broker copy (85–97% of the rate, within 1 h).
export const sameLoadRule: SameLoad = (c, l) => {
  const dt = Math.abs(c.postedAt - l.postedAt);
  if (c.brokerMc === l.brokerMc) return dt <= 6 * HOUR && (c.rate === null || l.rate === null || Math.abs(c.rate - l.rate) / c.rate <= 0.13);
  if (c.rate === null || l.rate === null || dt > HOUR) return false;
  const ratio = l.rate / c.rate;
  return ratio >= 0.85 && ratio <= 0.97;
};

export function createDedup(clock: Clock, sameLoad: SameLoad = sameLoadRule) {
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
    const side = sideOf(l);
    let candidates = 0;
    for (const oc of neighborCells(l.origin.lat, l.origin.lon, 4)) {
      const list = blocks.get(`${l.pickupDate}|${oc}|${l.dest.cell4}|${l.equipment}`);
      if (!list) continue;
      for (const c of list) {
        candidates++;
        if (Math.abs(c.postedAt - l.postedAt) > 6 * HOUR || !sameLoad(c, side)) continue;
        l.canonicalId = c.canonicalId;
        seen.set(l.key, { hash: l.contentHash, canonicalId: c.canonicalId });
        return { result: 'merged', canonicalId: c.canonicalId, candidates };
      }
    }
    l.canonicalId = `C${next++}`;
    seen.set(l.key, { hash: l.contentHash, canonicalId: l.canonicalId });
    const k = `${l.pickupDate}|${l.origin.cell4}|${l.dest.cell4}|${l.equipment}`;
    const entry = { ...side, canonicalId: l.canonicalId };
    const list = blocks.get(k);
    if (list) list.push(entry); else blocks.set(k, [entry]);
    return { result: 'new', canonicalId: l.canonicalId, candidates };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/dedup/features.test.ts src/dedup/dedup.test.ts`
Expected: PASS, 7 tests (3 new + 4 existing).

- [ ] **Step 5: Commit**

```bash
git add src/shared/strings.ts src/dedup
git commit -m "feat(dedup): shared pair features; pluggable same-load decision (rule stays default)"
```

---

### Task 2: Labeled pair export from the answer key

**Files:**
- Create: `ml/requirements.txt`, `ml/dedup/export_pairs.ts`
- Test: `ml/dedup/export.test.ts`
- Modify: `package.json` (`test` script includes `ml/**/*.test.ts`), `.gitignore`

**Interfaces:**
- Consumes: `createNormalizer`, `loadGazetteer`, `neighborCells`, `pairFeatures`, `sideOf`, `FEATURE_NAMES`, `sameLoadRule`
- Produces: `exportPairs(dataDir: string): { header: string[]; rows: (number | string)[][]; positives: number }`; CLI `node ml/dedup/export_pairs.ts --data DIR --out FILE.csv`; CSV columns = `FEATURE_NAMES…, rule, label, t, a_load, b_load`

Candidate pairs are made exactly the way dedup blocks them (same pickup date, origin cell or a neighbor, same destination cell, same equipment, posted within 6 h). Label 1 = both postings carry the same `load_id` in `truth.ndjson`.

- [ ] **Step 1: Update `package.json` and `.gitignore`**

Set the `test` script to:

```json
    "test": "node --test \"src/**/*.test.ts\" \"sims/**/*.test.ts\" \"scorer/**/*.test.ts\" \"ml/**/*.test.ts\"",
```

Append to `.gitignore`:

```
ml/dedup/data/
out-eval/
```

Create `ml/requirements.txt`:

```
gliner2==2.1.0
torch==2.15.0
transformers==5.22.1
scikit-learn==1.9.1
lightgbm==4.7.0
```

- [ ] **Step 2: Write the failing test**

`ml/dedup/export.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exportPairs } from './export_pairs.ts';
import { FEATURE_NAMES } from '../../src/dedup/features.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('exports labeled candidate pairs from a generated dataset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-pairs-'));
  const gen = spawnSync(process.execPath, [join(root, 'sim/gen.ts'), '--loads', '800', '--users', '5', '--hours', '2', '--seed', '3', '--out', dir], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const { header, rows, positives } = exportPairs(dir);
  assert.equal(header.length, FEATURE_NAMES.length + 5);
  assert.ok(rows.length > 50, `pairs ${rows.length}`);
  assert.ok(positives > 10 && positives < rows.length, `positives ${positives}`);
  const at = (name: string) => header.indexOf(name);
  for (const r of rows) {
    assert.equal(r.length, header.length);
    assert.ok(r[at('rule')] === 0 || r[at('rule')] === 1);
    assert.equal(r[at('label')], r[at('a_load')] === r[at('b_load')] ? 1 : 0);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test ml/dedup/export.test.ts`
Expected: FAIL, `Cannot find module` for `./export_pairs.ts`.

- [ ] **Step 4: Implement**

`ml/dedup/export_pairs.ts`:

```ts
// Builds labeled same-load pairs: every new posting vs the earlier postings dedup would compare it with.
//   node ml/dedup/export_pairs.ts --data ml/dedup/data/gen --out ml/dedup/data/pairs.csv
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGazetteer } from '../../src/normalize/gazetteer.ts';
import { createNormalizer } from '../../src/normalize/normalize.ts';
import { neighborCells } from '../../src/shared/geo.ts';
import { FEATURE_NAMES, pairFeatures, sideOf, type PairSide } from '../../src/dedup/features.ts';
import { sameLoadRule } from '../../src/dedup/dedup.ts';
import type { Board } from '../../src/shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());

export function exportPairs(dataDir: string): { header: string[]; rows: (number | string)[][]; positives: number } {
  const normalize = createNormalizer(loadGazetteer(join(here, '../../sim/data')));
  const truth = new Map<string, string>();
  for (const line of lines(join(dataDir, 'truth.ndjson'))) {
    const l = JSON.parse(line);
    for (const p of l.postings) truth.set(`${p.board}:${p.board_load_id}`, l.load_id);
  }
  const blocks = new Map<string, { side: PairSide; loadId: string }[]>();
  const seen = new Set<string>();
  const rows: (number | string)[][] = [];
  let positives = 0;
  for (const line of lines(join(dataDir, 'postings.ndjson'))) {
    const p = JSON.parse(line);
    const n = normalize({ board: p.board as Board, credentialId: null, userId: null, entryId: null, fetchedAt: 0, raw: p.raw });
    if (!n.ok || seen.has(n.load.key)) continue;          // refreshes of a known posting are stage 1's job
    seen.add(n.load.key);
    const l = n.load;
    const side = sideOf(l);
    const loadId = truth.get(l.key)!;
    for (const oc of neighborCells(l.origin.lat, l.origin.lon, 4)) {
      for (const c of blocks.get(`${l.pickupDate}|${oc}|${l.dest.cell4}|${l.equipment}`) ?? []) {
        if (Math.abs(c.side.postedAt - l.postedAt) > 6 * 3_600_000) continue;
        const label = c.loadId === loadId ? 1 : 0;
        positives += label;
        rows.push([...pairFeatures(c.side, side).map((x) => +x.toFixed(6)), sameLoadRule(c.side, side) ? 1 : 0, label, l.postedAt, c.loadId, loadId]);
      }
    }
    const k = `${l.pickupDate}|${l.origin.cell4}|${l.dest.cell4}|${l.equipment}`;
    const list = blocks.get(k);
    if (list) list.push({ side, loadId }); else blocks.set(k, [{ side, loadId }]);
  }
  return { header: [...FEATURE_NAMES, 'rule', 'label', 't', 'a_load', 'b_load'], rows, positives };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { data: { type: 'string' }, out: { type: 'string' } } });
  const r = exportPairs(a.data!);
  mkdirSync(dirname(a.out!), { recursive: true });
  writeFileSync(a.out!, [r.header.join(','), ...r.rows.map((x) => x.join(','))].join('\n') + '\n');
  console.log(JSON.stringify({ pairs: r.rows.length, positives: r.positives, out: a.out }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test ml/dedup/export.test.ts`
Expected: PASS.

- [ ] **Step 6: Generate the training data**

```bash
node sim/gen.ts --loads 30000 --users 10 --hours 24 --seed 11 --out ml/dedup/data/gen
node ml/dedup/export_pairs.ts --data ml/dedup/data/gen --out ml/dedup/data/pairs.csv
```

Expected: the second command prints `{"pairs":…,"positives":…}` with tens of thousands of pairs and thousands of positives.

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore ml/requirements.txt ml/dedup/export_pairs.ts ml/dedup/export.test.ts
git commit -m "feat(ml): labeled same-load pair export from the answer key"
```

---

### Task 3: Train, compare, export; score in TypeScript

**Files:**
- Create: `ml/dedup/train.py`, `src/dedup/classifier.ts`
- Generated and committed: `ml/dedup/model.json`
- Test: `src/dedup/classifier.test.ts`

**Interfaces:**
- Consumes: `ml/dedup/data/pairs.csv` (Task 2), `FEATURE_NAMES`, `pairFeatures`, `PairSide`
- Produces:
  - `model.json`: `{ kind: 'logistic', features: string[], mean: number[], scale: number[], coef: number[], intercept: number, threshold: number, parity: { x: number[]; p: number }[], metrics: {model, precision, recall, pr_auc?}[], thresholds: { logistic: number; lightgbm: number }, data: {...} }`
  - `type DedupModel`, `createClassifier(m: DedupModel): { prob(x: number[]): number; threshold: number; sameLoad: SameLoad }`, `loadClassifier(file: string)`

- [ ] **Step 1: Write the training script**

`ml/dedup/train.py`:

```python
"""Train the same-load classifier and compare it with the rule and LightGBM.

    ml/.venv/bin/python ml/dedup/train.py ml/dedup/data/pairs.csv ml/dedup

Splits by time (60% train / 20% threshold / 20% test). Exports logistic-regression weights to model.json
for the TypeScript engine; LightGBM is trained only for comparison.
"""
import csv
import json
import sys

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_recall_curve, precision_score, recall_score
from sklearn.preprocessing import StandardScaler

TARGET_PRECISION = 0.995
NON_FEATURES = ("rule", "label", "t", "a_load", "b_load")

pairs_csv, out_dir = sys.argv[1], sys.argv[2]
rows = list(csv.DictReader(open(pairs_csv)))
features = [c for c in rows[0].keys() if c not in NON_FEATURES]
X = np.array([[float(r[f]) for f in features] for r in rows])
y = np.array([int(r["label"]) for r in rows])
rule = np.array([int(r["rule"]) for r in rows])
t = np.array([float(r["t"]) for r in rows])

order = np.argsort(t, kind="stable")
n = len(rows)
tr, va, te = order[: int(0.6 * n)], order[int(0.6 * n): int(0.8 * n)], order[int(0.8 * n):]


def pick_threshold(prob, labels):
    """Highest-recall threshold whose precision meets the target (a wrong merge hides a real load)."""
    prec, rec, thr = precision_recall_curve(labels, prob)
    ok = [(r, th) for p, r, th in zip(prec[:-1], rec[:-1], thr) if p >= TARGET_PRECISION]
    return float(max(ok)[1]) if ok else 0.5


def report(name, pred, prob=None):
    d = {"model": name, "precision": round(float(precision_score(y[te], pred, zero_division=0)), 4),
         "recall": round(float(recall_score(y[te], pred)), 4)}
    if prob is not None:
        d["pr_auc"] = round(float(average_precision_score(y[te], prob)), 4)
    return d


scaler = StandardScaler().fit(X[tr])
lr = LogisticRegression(max_iter=2000).fit(scaler.transform(X[tr]), y[tr])
lr_th = pick_threshold(lr.predict_proba(scaler.transform(X[va]))[:, 1], y[va])
lr_te = lr.predict_proba(scaler.transform(X[te]))[:, 1]

gbm = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.05, num_leaves=31, verbose=-1).fit(X[tr], y[tr])
gbm_th = pick_threshold(gbm.predict_proba(X[va])[:, 1], y[va])
gbm_te = gbm.predict_proba(X[te])[:, 1]

metrics = [
    report("rule", rule[te]),
    report("logistic", (lr_te >= lr_th).astype(int), lr_te),
    report("lightgbm", (gbm_te >= gbm_th).astype(int), gbm_te),
]
model = {
    "kind": "logistic",
    "features": features,
    "mean": scaler.mean_.tolist(),
    "scale": scaler.scale_.tolist(),
    "coef": lr.coef_[0].tolist(),
    "intercept": float(lr.intercept_[0]),
    "threshold": lr_th,
    "thresholds": {"logistic": lr_th, "lightgbm": gbm_th},
    "parity": [{"x": X[te][i].tolist(), "p": float(lr_te[i])} for i in range(min(20, len(te)))],
    "metrics": metrics,
    "data": {"pairs": n, "positives": int(y.sum()), "train": len(tr), "validation": len(va), "test": len(te),
             "target_precision": TARGET_PRECISION},
}
json.dump(model, open(f"{out_dir}/model.json", "w"), indent=1)
print(json.dumps({"data": model["data"], "thresholds": model["thresholds"], "test": metrics}, indent=1))
```

- [ ] **Step 2: Train**

Run: `ml/.venv/bin/python ml/dedup/train.py ml/dedup/data/pairs.csv ml/dedup`
Expected: prints data sizes, both thresholds, and test precision/recall for `rule`, `logistic`, `lightgbm`; writes `ml/dedup/model.json`. Read the numbers before going on. If logistic precision on test is below 0.99, stop and look at the features before wiring the model into the engine.

- [ ] **Step 3: Write the failing test**

`src/dedup/classifier.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClassifier, loadClassifier, type DedupModel } from './classifier.ts';
import type { PairSide } from './features.ts';

const modelFile = join(dirname(fileURLToPath(import.meta.url)), '../../ml/dedup/model.json');

test('TypeScript scoring matches Python on the parity samples', () => {
  const m: DedupModel = JSON.parse(readFileSync(modelFile, 'utf8'));
  const c = createClassifier(m);
  assert.ok(m.parity.length > 0);
  for (const s of m.parity) assert.ok(Math.abs(c.prob(s.x) - s.p) < 1e-9, `${c.prob(s.x)} vs ${s.p}`);
});

test('a model trained on different features is refused', () => {
  const m: DedupModel = JSON.parse(readFileSync(modelFile, 'utf8'));
  assert.throws(() => createClassifier({ ...m, features: ['something_else'] }), /features/);
});

test('obvious cross-post merges, obvious stranger does not', () => {
  const c = loadClassifier(modelFile);
  const a: PairSide = { rate: 1950, brokerMc: '100', postedAt: 0, board: 'dat', originCity: 'CHICAGO', destCity: 'ATLANTA', originLat: 41.88, originLon: -87.63, destLat: 33.75, destLon: -84.39, miles: 716, equipmentDetail: 'V' };
  assert.equal(c.sameLoad(a, { ...a, board: 'truckstop', postedAt: 90_000, rate: 1975, miles: 712, equipmentDetail: 'VAN' }), true);
  assert.equal(c.sameLoad(a, { ...a, brokerMc: '999', rate: 1400, postedAt: 5 * 3_600_000 }), false);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test src/dedup/classifier.test.ts`
Expected: FAIL, `Cannot find module` for `./classifier.ts`.

- [ ] **Step 5: Implement**

`src/dedup/classifier.ts`:

```ts
// Logistic-regression same-load classifier trained by ml/dedup/train.py. Pure TypeScript: microseconds per pair.
import { readFileSync } from 'node:fs';
import { FEATURE_NAMES, pairFeatures, type PairSide } from './features.ts';
import type { SameLoad } from './dedup.ts';

export type DedupModel = {
  kind: 'logistic'; features: string[]; mean: number[]; scale: number[]; coef: number[]; intercept: number;
  threshold: number; parity: { x: number[]; p: number }[];
};

export function createClassifier(m: DedupModel): { prob(x: number[]): number; threshold: number; sameLoad: SameLoad } {
  if (m.features.join(',') !== FEATURE_NAMES.join(',')) throw new Error(`model features [${m.features}] do not match code features [${FEATURE_NAMES}]`);
  const prob = (x: number[]) => {
    let z = m.intercept;
    for (let i = 0; i < x.length; i++) z += (m.coef[i] * (x[i] - m.mean[i])) / m.scale[i];
    return 1 / (1 + Math.exp(-z));
  };
  return { prob, threshold: m.threshold, sameLoad: (c: PairSide, l: PairSide) => prob(pairFeatures(c, l)) >= m.threshold };
}

export const loadClassifier = (file: string) => createClassifier(JSON.parse(readFileSync(file, 'utf8')));
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test src/dedup/classifier.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add ml/dedup/train.py ml/dedup/model.json src/dedup/classifier.ts src/dedup/classifier.test.ts
git commit -m "feat(ml): train same-load classifier (rule vs logistic vs LightGBM); TS scoring with parity test"
```

---

### Task 4: Wire into the engine and measure end to end

**Files:**
- Modify: `src/engine.ts`, `src/engine.test.ts`, `scripts/run.ts`
- Create: `ml/dedup/compare.ts`
- Generated and committed: `ml/dedup/RESULTS.md`
- Modify: `README.md` (Focus section), `DESIGN.md` (§8 Day 2 checkbox)

**Interfaces:**
- Consumes: `loadClassifier`, `createDedup(clock, sameLoad)`
- Produces: `EngineConfig.dedupModel: string | null`; engine CLI `--dedup-model FILE`; launcher `--dedup-model FILE` (recorded as `config.dedup` in `RUN_RESULT`); `node ml/dedup/compare.ts --data out-eval` writes `ml/dedup/RESULTS.md`

- [ ] **Step 1: Engine option**

In `src/engine.ts`:

Add the import after the `createDedup` import:

```ts
import { loadClassifier } from './dedup/classifier.ts';
```

In `EngineConfig`, add the field after `bots: number`:

```ts
 dedupModel: string | null
```

so the type reads `…; maxUsers: number; bots: number; dedupModel: string | null };`.

Replace `const dedup = createDedup(clock);` with:

```ts
  const dedup = createDedup(clock, cfg.dedupModel ? loadClassifier(cfg.dedupModel).sameLoad : undefined);
```

In the CLI `parseArgs` options, add `'dedup-model': { type: 'string', default: '' },` and pass `dedupModel: a['dedup-model'] || null` in the `startEngine({...})` call.

In `src/engine.test.ts`, add `dedupModel: null` to both `startEngine({...})` calls (after `bots: 1`).

- [ ] **Step 2: Launcher option**

In `scripts/run.ts`, add the option `'dedup-model': { type: 'string', default: '' },` to `parseArgs`; append `...(a['dedup-model'] ? ['--dedup-model', a['dedup-model']] : [])` to the engine's argument list (after `...clockArgs`); and add `dedup: a['dedup-model'] || 'rule'` to the `config` object in `result`.

- [ ] **Step 3: Run the existing tests**

Run: `npm test`
Expected: all pass (no behavior change while `dedupModel` is null).

- [ ] **Step 4: Comparison script**

`ml/dedup/compare.ts`:

```ts
// End-to-end comparison on the same data: dedup rule vs trained classifier. Writes ml/dedup/RESULTS.md.
//   node sim/gen.ts --loads 3000 --users 100 --hours 2 --seed 1 --out out-eval
//   node ml/dedup/compare.ts --data out-eval
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const { values: a } = parseArgs({ options: { data: { type: 'string', default: 'out-eval' }, speed: { type: 'string', default: '60' }, minutes: { type: 'string', default: '1.5' } } });
const modelFile = join(here, 'model.json');

const run = (extra: string[]) => {
  const r = spawnSync(process.execPath, [join(root, 'scripts/run.ts'), '--data', a.data!, '--speed', a.speed!, '--minutes', a.minutes!, '--port-base', '17101', '--metrics-port', '19465', ...extra], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RUN_RESULT '))!.slice(11));
};
const rule = run([]);
const model = run(['--dedup-model', modelFile]);
const m = JSON.parse(readFileSync(modelFile, 'utf8'));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const row = (name: string, r: any) => `| ${name} | ${r.score.expected} | ${r.score.delivered} | ${pct(r.score.missRate)} | ${r.score.duplicates} (${pct(r.score.duplicateRate)}) | ${r.score.unexpected} | ${r.score.latencySec.p50.toFixed(0)} / ${r.score.latencySec.p95.toFixed(0)} s |`;

writeFileSync(join(here, 'RESULTS.md'), `# Dedup classifier: results

Generated by \`node ml/dedup/compare.ts --data ${a.data}\` on ${new Date().toISOString().slice(0, 10)}.

## Offline (held-out pairs, split by time)

Training data: ${m.data.pairs} candidate pairs (${m.data.positives} same-load) from \`sim/gen.ts --seed 11\`. Threshold chosen for precision ≥ ${m.data.target_precision} on the validation split (logistic ${m.thresholds.logistic.toFixed(3)}, LightGBM ${m.thresholds.lightgbm.toFixed(3)}).

| Model | Precision | Recall | PR-AUC |
| --- | --- | --- | --- |
${m.metrics.map((x: any) => `| ${x.model} | ${x.precision} | ${x.recall} | ${x.pr_auc ?? '—'} |`).join('\n')}

The engine ships the logistic model (12 weights, pure TypeScript). LightGBM is listed for comparison.

## End to end (same data and settings, scored against the answer key)

Data: \`${a.data}\`, ${a.minutes} real minutes at ${a.speed}× speed.

| Dedup | Expected | Delivered | Missed | Duplicates | Unexpected | p50 / p95 latency |
| --- | --- | --- | --- | --- | --- | --- |
${row('rule', rule)}
${row('classifier', model)}
`);
console.log(JSON.stringify({ rule: rule.score, classifier: model.score }));
```

- [ ] **Step 5: Run the comparison**

```bash
node sim/gen.ts --loads 3000 --users 100 --hours 2 --seed 1 --out out-eval
node ml/dedup/compare.ts --data out-eval
```

Expected: about 4 minutes; prints both score objects and writes `ml/dedup/RESULTS.md`. The target is duplicates under 1% with the miss rate no worse than the rule's. Whatever the numbers are, they go into the docs as they came out.

- [ ] **Step 6: Update the docs**

In `DESIGN.md` §8, change `- [ ] Same-load classifier trained on generator pairs: …` to `- [x]` and append ` (results: ml/dedup/RESULTS.md)`.

In `README.md`, in the "Focus" section, append to the **ML: same-load classifier** bullet: ` Results: [ml/dedup/RESULTS.md](ml/dedup/RESULTS.md).`

- [ ] **Step 7: Run all tests and commit**

```bash
npm test
git add src/engine.ts src/engine.test.ts scripts/run.ts ml/dedup/compare.ts ml/dedup/RESULTS.md README.md DESIGN.md
git commit -m "feat(engine): --dedup-model; end-to-end comparison rule vs classifier"
```
