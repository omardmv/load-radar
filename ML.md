# Machine learning in Load Radar

Every model in the system: what it decides, how it was trained, how well it does, where it runs, and what we don't
know yet. Kept up to date as models change. Raw numbers: [ml/dedup/RESULTS.md](ml/dedup/RESULTS.md),
[ml/parser/RESULTS.md](ml/parser/RESULTS.md).

| Model | Decides | Where it runs | How often | Status |
| --- | --- | --- | --- | --- |
| **Same-load classifier** (logistic regression) | Are these two board postings the same real load? | Engine, hot path, every new posting with candidates | Thousands of pairs/s | **Live** (default since 2026-11-04) |
| **GLiNER2** (`fastino/gliner2-base-v1`) | Which words in a typed search are the origin, destination, rate, deadhead; which equipment | `gliner2` container (CPU), called by the parser | Only when rules miss equipment or origin | Live |
| Qwen 2.5 1.5B (Ollama) | Same as GLiNER2, as a chat model with a JSON schema | `ollama` container | Never in the live path | Eval only (slower and less accurate) |

Principle across all three: **cheap deterministic code first, a model only where the code can't decide, and every
decision measured against an answer key** (the simulator's for dedup, a labeled eval set for the parser).

---

## 1. Same-load classifier (dedup)

### The problem

One real load appears on the boards many times: refreshed (same id), reposted (new id), cross-posted on other boards
(different id, different spelling: "FT. WORTH" vs "Fort Worth"), and re-posted by a second broker at a 5-12% lower
rate. Dedup must recognize these so a dispatcher gets **one** alert per real load. The opposite mistake is worse:
merging two *different* loads (the same lane, same day, same equipment, posted twice by a busy shipper) hides one of
them from every dispatcher. So the costs are asymmetric:

- **Wrong merge** (false positive) → a real load is never alerted. Expensive: the product failed.
- **Missed merge** (false negative) → one duplicate alert. Cheap: noise.

### Two stages

1. **Exact** (no ML): same board id → refresh or update. Free.
2. **Same-load decision** on candidates that share pickup date, origin area (geohash level 4 and neighbors),
   destination area and equipment, posted within 6 h. This is the classifier. Blocking keeps the candidate list short
   (typically 0-10), so the model scores a handful of pairs per posting.

### Training data: free labels from the simulator

The generator writes an answer key (`truth.ndjson`): for every real load, every posting that carries it. So every
candidate pair is labeled automatically: same `load_id` → 1, else 0.

- `node sim/gen.ts --loads 30000 --users 10 --hours 24 --seed 11 --out ml/dedup/data/gen`
- `node ml/dedup/export_pairs.ts --data ml/dedup/data/gen --out ml/dedup/data/pairs.csv`
- **305,609 pairs, 74,154 same-load (24%)**, built exactly the way the engine blocks candidates.
- Training world uses **seed 11**; end-to-end evaluation uses **seed 1**, a world the model never saw.

### Features (18), computed in one place

`src/dedup/features.ts` (`pairFeatures`) is the only code that computes features. The exporter calls it to make
training data and the engine calls it at run time, so training and serving can't drift apart.

| Group | Features | Why |
| --- | --- | --- |
| Rate | `rate_rel_diff`, `rate_missing`, `rate_ratio` | Cross-posts keep the rate (±$50); a co-broker takes a margin |
| Who and when | `same_broker`, `dt_hours`, `same_board` | Reposts come from the same broker within hours |
| Where | `origin_name_sim`, `dest_name_sim` (Jaro-Winkler), `origin_miles`, `dest_miles`, `miles_rel_diff` | Same town spelled differently is close; a different town in the same area is not |
| What | `same_equipment_detail`, `weight_rel_diff`, `weight_missing`, `notes_sim` | **A real load keeps its weight and comments on every board.** Different loads on the same lane rarely share both |
| Shapes a linear model can't build | `cobroker_band_dist` (distance of the rate ratio from ~0.915), `other_broker_x_dt`, `same_broker_x_rate_diff` | The co-broker pattern is a band, not a slope; rate and time mean different things for the same broker vs another |

The first version had only the first 12 features. Logistic regression then reached the precision target only by
merging almost nothing (recall 4.5%): without weight and comments it can't tell two loads on one lane apart. Adding
weight and comments (the normalizer now keeps both, including portal_b's "12.00 lbs" that means 12,000) took recall to
99.4%. Largest weights after scaling: weight difference (−12.4), comment similarity (+11.8), origin name similarity
(+4.7), destination name similarity (+2.4), same broker (+1.5).

### Training and the threshold

`ml/.venv/bin/python ml/dedup/train.py ml/dedup/data/pairs.csv ml/dedup`

- **Split by time**: first 60% of pairs train, next 20% choose the threshold, last 20% test. A random split would let
  the model see the future (later reposts of loads it trained on).
- **Threshold policy**: the highest-recall threshold whose **precision ≥ 0.995** on the validation split, because a
  wrong merge costs far more than a duplicate. Logistic threshold: 0.712.
- Models: the hand-written rule (baseline), logistic regression (scikit-learn, standardized features), LightGBM (300
  trees). Training time: 0.06 s and 2.3 s.

### Results

Offline, the last 20% of pairs by time (61,122 pairs):

| Model | Precision | Recall | Wrong merges (hidden loads) | Missed merges (duplicates) | PR-AUC |
| --- | --- | --- | --- | --- | --- |
| Rule | 0.900 | 92.7% | 1,806 | 1,285 | — |
| **Logistic regression** | **0.9985** | **99.4%** | **27** | 101 | 0.9999 |
| LightGBM | 0.9983 | 99.9% | 29 | 20 | 0.9998 |

End to end, the whole engine on an unseen world (seed 1, 3,000 loads, 100 dispatchers, 90 simulated minutes), scored
against the answer key (`node ml/dedup/compare.ts --data out-eval`):

| Dedup | Missed alerts | Duplicate alerts | p50 / p95 post → alert |
| --- | --- | --- | --- |
| Rule | 4.73% (105) | 2.74% (58) | 3.0 / 127 s |
| **Classifier** | **1.80% (40)** | **0.00% (0)** | 2.9 / 120 s |

### Why logistic regression and not LightGBM

LightGBM finds 80 more merges in 61K pairs, but needs a tree runtime inside the engine. Logistic regression is 18
multiply-adds in plain TypeScript (`src/dedup/classifier.ts`): **~130 ns per pair**, no Python, no native library, easy
to read and to explain ("a heavier weight difference pushes toward 'different load'"). The engine scores a few pairs
per posting, so the gap in recall is worth less than the simplicity. If misses ever matter more, LightGBM can be
exported to ONNX and run in the engine.

### Serving and safety

- `model.json` holds weights, scaler, threshold, feature names, and **parity samples**: Python's probabilities for 20
  test pairs. On load, the engine recomputes them in TypeScript and **refuses the model** if any differs by more than
  1e-9 (measured: 1.2e-15), or if the feature list doesn't match the code's.
- Engine flag `--dedup-model ml/dedup/model.json`; without it the rule runs. Live mode uses the model
  (`docker-compose.yml`); batch runs record which one ran in `RUN_RESULT.config.dedup`.
- Monitoring: `dedup_total{result}` (new / merged / refresh / updated) on the Grafana dashboard ("Dedup decisions/s"),
  and the SLOs catch the consequences: duplicates and misses are scored live against the answer key (SLO.md).

### What we don't know yet (honest limits)

- **The simulator copies weight and comments exactly across a load's postings.** Real brokers sometimes rewrite
  comments or round weights, so the two strongest features are weaker on real data and real precision will be lower.
  Before trusting the numbers on a real board: run the model in **shadow mode** (decide with the rule, log what the
  model would have done) and label disagreements.
- Labels on real data won't be free. Sources: a "this is a duplicate" / "you hid a load" button in the UI, and broker
  reference numbers when boards expose them.
- Drift: new boards, new spellings, new broker habits. Retrain on a schedule and compare against the current model on
  the same held-out week before switching (the parity and feature-name checks make a bad swap fail loudly).

---

## 2. Search parser: rules + GLiNER2

Turns a dispatcher's sentence ("reefer outta fresno, nothing under 3, 100 dh") into a saved search.

1. **Rules** (`src/parse/extract.ts`, ~0.1 ms) pull out equipment, origin, destination, rate floor, deadhead.
2. **GLiNER2** runs only when the rules miss the equipment or the origin. It's an *extraction* model, not a chat
   model: given label descriptions it scores every span of the text and returns the best spans with a confidence, plus
   an equipment classification. It can only point at words in the input, so it can't invent a city. ~50 ms on CPU.
3. **One normalizer** (`src/parse/normalize.ts`) turns spans from either source into a real search (gazetteer lookup,
   numbers, defaults) and turns anything unclear into a **question** instead of a guess.

Eval (40 labeled searches, `node ml/parser/eval.ts`, details in [ml/parser/RESULTS.md](ml/parser/RESULTS.md)):

| Contender | All fields correct | Model calls | Latency p50 / p95 |
| --- | --- | --- | --- |
| Rules only | 95% | 0 | 0.0 / 1.1 ms |
| GLiNER2 only | 60% | 40 | 56 / 64 ms |
| **Rules + GLiNER2 (live)** | **98%** | 2 | 0.0 / 52 ms |
| Qwen 2.5 1.5B only | 80% | 40 | 521 / 576 ms (Mac); ~15 s on the server CPU |
| Rules + Qwen | 95% | 2 | 0.1 / 440 ms |

Limits: the rules were written while looking at these 40 examples, so rule-based numbers are optimistic; 40 examples
means one example is 2.5 points. Known miss: "anywhere but NY" (exclusions aren't supported), and "loads out of
springfield tmrw" sets Springfield as the destination too.

Observability: every model call is a GenAI span (input, output, model, latency, tokens) in Langfuse and Tempo, counted
in Prometheus (`llm_calls_total`, `llm_duration_*`); eval runs attach correctness scores to each call in Langfuse.

---

## Changelog

- **2026-11-04** Same-load classifier trained and made the default in live mode. Normalizer keeps weight and comments.
  Rule kept as the fallback (`--dedup-model` unset).
- **2026-11-03** Search parser: rules + GLiNER2 hybrid live; Qwen evaluated and kept out of the live path.
