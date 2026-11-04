// Logistic-regression same-load classifier trained by ml/dedup/train.py. Pure TypeScript: one dot product per
// candidate pair (18 features), no Python at runtime. model.json carries parity samples: Python's probabilities
// for a few test pairs, which this code must reproduce (checkParity) before the engine uses the model.
import { readFileSync } from 'node:fs';
import { FEATURE_NAMES, pairFeatures, type PairSide } from './features.ts';
import type { SameLoad } from './dedup.ts';

export type DedupModel = {
  kind: 'logistic'; features: string[]; mean: number[]; scale: number[]; coef: number[]; intercept: number;
  threshold: number; parity: { x: number[]; p: number }[];
};

export function createClassifier(m: DedupModel): { prob(x: number[]): number; threshold: number; sameLoad: SameLoad; checkParity(): number } {
  if (m.features.join(',') !== FEATURE_NAMES.join(',')) throw new Error(`model features [${m.features}] do not match code features [${FEATURE_NAMES}]`);
  const prob = (x: number[]) => {
    let z = m.intercept;
    for (let i = 0; i < x.length; i++) z += (m.coef[i] * (x[i] - m.mean[i])) / m.scale[i];
    return 1 / (1 + Math.exp(-z));
  };
  // largest difference from Python's probabilities on the parity samples; refuse the model if it disagrees
  const checkParity = () => {
    const worst = Math.max(0, ...m.parity.map((s) => Math.abs(prob(s.x) - s.p)));
    if (worst > 1e-9) throw new Error(`model.json parity failed: TypeScript differs from Python by ${worst}`);
    return worst;
  };
  return { prob, threshold: m.threshold, sameLoad: (c: PairSide, l: PairSide) => prob(pairFeatures(c, l)) >= m.threshold, checkParity };
}

export function loadClassifier(file: string) {
  const c = createClassifier(JSON.parse(readFileSync(file, 'utf8')));
  c.checkParity();
  return c;
}
