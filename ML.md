# Machine learning in Load Radar

Every model in the system: what it decides, how it was trained, how well it does, where it runs, and what we don't
know yet. Kept up to date as models change. Raw numbers: [ml/dedup/RESULTS.md](ml/dedup/RESULTS.md),
[ml/parser/RESULTS.md](ml/parser/RESULTS.md), [ml/agent/RESULTS.md](ml/agent/RESULTS.md).

| Model | Decides | Where it runs | How often | Status |
| --- | --- | --- | --- | --- |
| **Same-load classifier** (logistic regression) | Are these two board postings the same real load? | Engine, hot path, every new posting with candidates | Thousands of pairs/s | **Live** (default since 2026-11-04) |
| **GLiNER2** (`fastino/gliner2-base-v1`) | Which words in a typed search are the origin, destination, rate, deadhead; which equipment | `gliner2` container (CPU), called by the parser | Only when rules miss equipment or origin | Live |
| Qwen 2.5 1.5B (Ollama) | Same as GLiNER2, as a chat model with a JSON schema | `ollama` container | Never in the live path | Eval only (slower and less accurate) |
| **Qwen 2.5 3B** (Ollama), load-decision agent | What the broker's comments require (tarps, frozen, other); code then decides book / negotiate / ask / skip | `ollama` container (CPU) | When a dispatcher clicks "Should I take it?" | **Live** (hybrid mode, prompt v2) |

Principle across all of them: **cheap deterministic code first, a model only where the code can't decide, and every
decision measured against an answer key** (the simulator's for dedup, a labeled eval set for the parser and the agent).

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
| Rule | 4.73% (105) | 2.74% (58) | 3.0 / 127 s (old clock) |
| **Classifier** | **1.80% (40)** | **0.00% (0)** | 2.7 / 5.3 s (re-scored; old clock: 2.9 / 120 s) |

Latency is measured from when the load first appears on a board the dispatcher has a login for. Until 2026-11-06 the
scorer started at the first posting on *any* board, so co-broker reposts (~10 min later, on another board) made the
p95 look like 120 s. Misses and duplicates don't change with the clock. The rule run's deliveries weren't kept, so
its latency is still the old number.

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

## 3. Load-decision agent: "Should I take it?"

### The problem

An alert says a load matches. The dispatcher still has to decide: book it, counter-offer, ask the broker for the rate,
or skip. That depends on numbers (rate per mile vs the market, deadhead, weight) and on the broker's free-text comments
("8FT TARPS", "-10F FROZEN", "chilled 34F", "chains req"), which decide whether the truck can carry it at all.

The dispatch policy is written down ([src/agent/policy.ts](src/agent/policy.ts)): skip on too much deadhead, too heavy,
tarps or frozen the truck can't do; otherwise target = max(market rate, truck minimum); book at or above target,
negotiate at 85% or more (counter rounded to $25), ask when there's no rate, skip below that.

### Four designs, compared on the same cases

| Mode | Who reads the comments | Who applies the policy |
| --- | --- | --- |
| **rules** | Keyword regexes | Code |
| **hybrid** | The model (one call, JSON schema: `needs_tarps`, `needs_frozen`, `other_requirements`) | Code |
| **context** | The model gets all facts in one prompt and decides everything | The model |
| **tools** | The model calls `get_load`, `get_truck`, `get_market_rate`, `get_deadhead`, then decides | The model |

The tool loop has guards: a repeated call returns a note instead of running again, and tools are removed once every
fact is in, so a small model can't loop forever.

### Eval sets and graders

- **main** (24 cases, [ml/agent/cases.jsonl](ml/agent/cases.jsonl)): loads from the world model (seed 21), 6 per
  verdict, 9 with comment traps (chilled vs frozen, chains vs tarps, "NO TARP").
- **messy** (16 cases, [ml/agent/messy_comments.json](ml/agent/messy_comments.json)): real-world phrasings of tarp and
  frozen requirements, labeled by hand, where the comment alone decides the verdict. The keyword rule reads 9 of 16.
- Graders are deterministic, no LLM judge: verdict right; target rate within $50; **grounded** (every number in the
  reasons appears in the facts); valid JSON; comments read right. Every case is a trace in Langfuse with scores
  attached (`agent_verdict_correct`, `agent_grounded`).

### Results (server CPU, temperature 0)

| Design | Model | main verdict | messy verdict | p50 latency |
| --- | --- | --- | --- | --- |
| rules | — | 100% | **56%** | 0 s |
| context | 1.5B / 3B / 7B | 29% / 42% / 33% | — | 35–90 s |
| tools | 1.5B / 3B / 7B | 38% / 21% / 25% | — | 89–172 s |
| hybrid, prompt v1 | 1.5B / 3B / 7B | 83% / 83% / 92% | 94% / 100% / 100% | 3–10 s |
| hybrid, prompt v2 | 1.5B / 3B / 7B | 96% / 88% / 100% | 94% / 100% / 100% | 2–8 s |

Full table (target, grounded, tokens, p95): [ml/agent/RESULTS.md](ml/agent/RESULTS.md).

What it means:

1. **Letting the model do the arithmetic and the policy fails, and a bigger model doesn't fix it.** 7B whole-decision
   is 25–33%, no better than 1.5B. The misses are policy errors (wrong threshold, "negotiate" when it should book,
   invented counter-offers), not missing facts. Tools make it slower (3 calls, 2,200 tokens in) without helping.
2. **The split works**: the model does only what code can't (read free text), code does what models are bad at
   (compare numbers, apply rules). Same 1.5B model: 29–38% → 94–96%, and 30× faster.
3. **Keywords are perfect on the cases they were written for and fail on real wording** (56% on messy). The model
   reads "tarped load", "reefer @ -10", "keep frozen" correctly.
4. **Prompt v1 → v2**: v1's misses on main were chilled loads (28F, 34F) read as frozen and chains read as tarps. v2
   adds exact thresholds and four examples. Caveat: v2 was written after looking at main's misses, so main is no
   longer a blind test for v2; messy wasn't used and didn't change (94% / 100% / 100%).

### Which model runs live

**3B, hybrid, prompt v2.** It's 100% on the blind messy set (1.5B misses one), ~3 s at p50 on the server's CPU, and
its 88% on main is 3 misses on a set that is no longer blind. 7B is 100% everywhere but ~8 s p50 and it competes
with the live service for the same 4 cores. The UI shows both the model's reading of the comments and the policy
verdict, so a dispatcher sees why.

### Honest limits

- 24 + 16 cases: one case is 4–6 points. Differences of one case between models are noise.
- The cases come from our own world model, and the messy phrasings were written by us, not taken from real boards.
- p95 latency is high (14–29 s) because the eval shares the CPU with the live service and Ollama loads models on
  demand.
- The policy itself is ours. A real dispatcher's policy has more inputs (lane preferences, broker reputation,
  hours of service).

---

## Changelog

- **2026-11-06** Scorers (batch and live) start the latency clock at the first posting on a board the user can see.
  Dedup end-to-end p95 re-scored 120 s -> 5.3 s (same deliveries). Normalizer: Truckstop's 14-character names now
  resolve when normalizing changes their length (Fort/Saint/Mount, dots, a cut on a space) or the cut hits an alias
  ("ONTARIO (INLAN"); place failures on Truckstop 1.38% -> 0.01% on a 144K-posting world.
- **2026-11-04** Load-decision agent: four designs evaluated; hybrid (model reads comments, code decides) with prompt v2
  and Qwen 2.5 3B is live.
- **2026-11-04** Same-load classifier trained and made the default in live mode. Normalizer keeps weight and comments.
  Rule kept as the fallback (`--dedup-model` unset).
- **2026-11-03** Search parser: rules + GLiNER2 hybrid live; Qwen evaluated and kept out of the live path.
