# Machine learning in Load Radar

Every model in the system: what it decides, how it's trained, how well it does, where it runs, and what we don't
know yet. Raw numbers: [ml/dedup/RESULTS.md](ml/dedup/RESULTS.md), [ml/parser/RESULTS.md](ml/parser/RESULTS.md),
[ml/agent/RESULTS.md](ml/agent/RESULTS.md).

| Model | Decides | Where it runs | How often | Status |
| --- | --- | --- | --- | --- |
| **Same-load classifier** (logistic regression) | Are these two postings the same real load? | Engine, hot path | Thousands of pairs/s | **Live** |
| **GLiNER2** (`fastino/gliner2-base-v1`) | Which words in a search are origin, destination, rate, deadhead, equipment | `gliner2` container (CPU) | Only when rules miss equipment or origin | Live |
| Qwen 2.5 1.5B (Ollama) | Same as GLiNER2, as a chat model with a JSON schema | `ollama` container | Never in the live path | Eval only |
| **Qwen 2.5 3B** (Ollama), load-decision agent | What the broker's comments require; code decides book / negotiate / ask / skip | `ollama` container (CPU) | On "Should I take it?" | **Live** (hybrid, prompt v2) |

Principle across all of them: cheap deterministic code first, a model only where code can't decide, every decision
measured against an answer key.

---

## 1. Same-load classifier (dedup)

One load can post many times: refreshed, reposted, cross-posted under a different spelling, or re-posted by a
second broker at a lower rate. Dedup collapses these to one alert. A **wrong merge** hides a real load
(expensive); a **missed merge** is one duplicate alert (cheap).

**Two stages:** exact match on board id, free. Otherwise a classifier scores candidates sharing pickup date,
origin area, destination area and equipment within 6 h — blocking keeps candidates to 0–10 per posting.

**Training data:** the simulator's answer key labels every pair for free (same `load_id` → 1, else 0). 305,609
pairs, 74,154 same-load (24%), built the same way the engine blocks candidates. Train on seed 11; end-to-end
evaluation on seed 1 (unseen).

**Features (18)**, computed once in `src/dedup/features.ts` (`pairFeatures`), shared by training and serving:

| Group | Features | Why |
| --- | --- | --- |
| Rate | `rate_rel_diff`, `rate_missing`, `rate_ratio` | Co-broker takes a margin |
| Who/when | `same_broker`, `dt_hours`, `same_board` | Reposts: same broker, within hours |
| Where | `origin_name_sim`, `dest_name_sim`, `origin_miles`, `dest_miles`, `miles_rel_diff` | Misspelled town is close; different town isn't |
| What | `same_equipment_detail`, `weight_rel_diff`, `weight_missing`, `notes_sim` | Weight and comments persist across boards |
| Non-linear | `cobroker_band_dist`, `other_broker_x_dt`, `same_broker_x_rate_diff` | Co-broker pattern is a band, not a slope |

Largest weights after scaling: weight difference (−12.4), comment similarity (+11.8), origin name similarity
(+4.7), destination name similarity (+2.4), same broker (+1.5).

**Training:** `ml/dedup/train.py`. Split by time (60% train / 20% validate / 20% test), so the model can't see
the future. Threshold: highest recall at precision ≥ 0.995 on validation → **0.712**. Compared: hand-written
rule, logistic regression (scikit-learn), LightGBM (300 trees).

**Results**, last 20% of pairs by time (61,122 pairs):

| Model | Precision | Recall | Wrong merges | Missed merges | PR-AUC |
| --- | --- | --- | --- | --- | --- |
| Rule | 0.900 | 92.7% | 1,806 | 1,285 | — |
| **Logistic regression** | **0.9985** | **99.4%** | **27** | 101 | 0.9999 |
| LightGBM | 0.9983 | 99.9% | 29 | 20 | 0.9998 |

End to end, the whole engine on an unseen world (seed 1, 3,000 loads, 100 dispatchers, 90 simulated minutes),
scored against the answer key (latency measured from the first posting on a board the dispatcher can see):

| Dedup | Missed alerts | Duplicate alerts | p50 / p95 post → alert |
| --- | --- | --- | --- |
| Rule | 4.73% (105) | 2.74% (58) | not measured |
| **Classifier** | **1.80% (40)** | **0.00% (0)** | **2.7 / 5.3 s** |

Shipped as logistic regression, not LightGBM (80 more merges in 61K pairs): it's 18 multiply-adds in plain
TypeScript (`src/dedup/classifier.ts`), ~130 ns/pair, no tree runtime, easy to explain. Served via `model.json`
(weights, scaler, threshold, 20 parity samples); the engine refuses the model if its own recompute differs from
Python by more than 1e-9 (measured 1.2e-15), or the feature list doesn't match. Flag
`--dedup-model ml/dedup/model.json`; without it, the rule runs. Monitored by `dedup_total{result}` on the
dashboard; the live SLOs score duplicates and misses against the answer key.

**Limits:** the simulator copies weight and comments exactly across postings; real brokers rewrite them, so real
precision will likely be lower — shadow mode (decide with the rule, log what the model would do) comes before
trusting it on a real board. Labels on real data aren't free (would need a duplicate/hidden-load button, or
broker reference numbers). Drift (new boards, spellings, habits) needs scheduled retraining against a held-out
week before switching.

---

## 2. Search parser: rules + GLiNER2

Turns a dispatcher's sentence ("reefer outta fresno, nothing under 3, 100 dh") into a saved search.

1. **Rules** (`src/parse/extract.ts`, ~0.1 ms) pull out equipment, origin, destination, rate floor, deadhead.
2. **GLiNER2** runs only when rules miss equipment or origin: an extraction model that scores spans of the text
   against label descriptions (~50 ms, CPU). It can only point at words already in the input.
3. **Normalizer** (`src/parse/normalize.ts`) turns spans into a real search (gazetteer, numbers, defaults), and
   turns anything unclear into a question instead of a guess.

Eval (40 labeled searches, `node ml/parser/eval.ts`):

| Contender | All fields correct | Model calls | Latency p50 / p95 |
| --- | --- | --- | --- |
| Rules only | 95% | 0 | 0.0 / 1.1 ms |
| GLiNER2 only | 60% | 40 | 56 / 64 ms |
| **Rules + GLiNER2 (live)** | **98%** | 2 | 0.0 / 52 ms |
| Qwen 2.5 1.5B only | 80% | 40 | 521 / 576 ms |
| Rules + Qwen | 95% | 2 | 0.1 / 440 ms |

Limits: rules were written looking at these 40 examples, so the rule-based numbers are optimistic (one example is
2.5 points). Known miss: "anywhere but NY" (exclusions unsupported); "loads out of springfield tmrw" sets
Springfield as destination too.

Every model call is a GenAI span (input, output, model, latency, tokens) in Langfuse and Tempo, counted in
Prometheus (`llm_calls_total`, `llm_duration_*`); evals attach correctness scores to each call in Langfuse.

---

## 3. Load-decision agent: "Should I take it?"

An alert says a load matches; the dispatcher still has to decide: book, counter-offer, ask the broker for the
rate, or skip. That depends on numbers (rate per mile, deadhead, weight) and on free-text comments ("8FT TARPS",
"-10F FROZEN", "chains req") that decide whether the truck can carry it at all.

Dispatch policy ([src/agent/policy.ts](src/agent/policy.ts)): skip on too much deadhead, too heavy, or
tarps/frozen the truck can't do; otherwise target = max(market rate, truck minimum); book at or above target,
negotiate at 85%+ (counter rounded to $25), ask when there's no rate, skip below that.

**Four designs**, compared on the same cases:

| Mode | Who reads the comments | Who applies the policy |
| --- | --- | --- |
| **rules** | Keyword regexes | Code |
| **hybrid** | The model (one call, JSON schema) | Code |
| **context** | The model, given all facts in one prompt | The model |
| **tools** | The model calls `get_load`/`get_truck`/`get_market_rate`/`get_deadhead`, then decides | The model |

Eval sets: **main** (24 cases, 6 per verdict, 9 comment traps) and **messy** (16 real-world tarp/frozen
phrasings; the keyword rule reads 9 of 16). Graders are deterministic: verdict right, target rate within $50,
grounded in the facts, valid JSON, comments read right.

**Results** (server CPU, temperature 0):

| Design | Model | main verdict | messy verdict | p50 latency |
| --- | --- | --- | --- | --- |
| rules | — | 100% | **56%** | 0 s |
| context | 1.5B / 3B / 7B | 29% / 42% / 33% | — | 35–90 s |
| tools | 1.5B / 3B / 7B | 38% / 21% / 25% | — | 89–172 s |
| hybrid, prompt v1 | 1.5B / 3B / 7B | 83% / 83% / 92% | 94% / 100% / 100% | 3–10 s |
| **hybrid, prompt v2** | 1.5B / 3B / 7B | 96% / 88% / 100% | 94% / 100% / 100% | 2–8 s |

The model doing arithmetic and policy fails regardless of size (7B whole-decision is 25–33%, no better than
1.5B) — the misses are policy errors, not missing facts. Splitting the work (model reads text, code applies
policy) takes the same 1.5B model from 29–38% to 94–96%, and 30× faster. Keyword rules are perfect on cases
written for them and weak on real wording (56% messy); the model reads "tarped load" or "keep frozen" correctly.

**Live: 3B, hybrid, prompt v2.** 100% on the blind messy set, ~3 s p50 on the server's CPU. 7B is 100% everywhere
but ~8 s p50 and competes with the live service for the same cores. The UI shows both the model's reading of the
comments and the policy verdict.

**Limits:** 24 + 16 cases is a small eval (one case is 4–6 points; a one-case difference is noise). Cases and
messy phrasings come from our own world model and writing, not real boards. p95 latency is high (14–29 s) because
the eval shares the CPU with the live service and Ollama. main is no longer a blind test for prompt v2; messy
stayed untouched. The policy is ours; a real dispatcher's has more inputs (lane preferences, broker reputation,
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
