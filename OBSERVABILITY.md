# Load Radar: observability plan

How we see problems, take measurements and explain performance. [DESIGN.md](DESIGN.md) says what the system does; [LLD.md](LLD.md) says how. This document says how we **know** it's working, and what to look at when it isn't.

---

## 1. Questions it must answer

If a dashboard panel or alert doesn't answer one of these, it doesn't get built.

| Who asks | Question | Answered by |
| --- | --- | --- |
| Customer | How fast did I hear about this load? Did I miss any? Did I get duplicates? Is my account safe? | Post-to-alert latency, scorer's misses and duplicates, bans |
| On-call | Something is wrong. Where? | Latency broken into parts (section 3) + per-stage RED + per-resource USE |
| On-call | Why was *this* alert late? | One trace per load, linked from the latency histogram (exemplars) |
| Load test | What breaks first, and at what load? | Step-load runs with the saturated resource recorded (section 9) |
| Product | Is the budget well spent? | Alerts per upstream request, budget use by lane heat |
| Builder | Did my change make it slower? | Before/after run comparison, CPU profiles |

## 2. Signals and tools

| Signal | Use it for | Tool (demo) | Notes |
| --- | --- | --- | --- |
| **Metrics** | Trends, SLOs, alerts, capacity | `prom-client` → Prometheus → Grafana | Cheap; aggregated; low-cardinality labels only |
| **Traces** | Following one load through every stage | OpenTelemetry SDK → OTel Collector → Jaeger | Sampled (section 7) |
| **Logs** | Rare events with details: bans, circuit opens, unknown places, LLM calls | `pino` JSON to stdout (+ Loki if time allows) | Every log line carries `trace_id` when there is one |
| **Profiles** | Why CPU or memory is high | `node --cpu-prof` + flame graphs; heap snapshots; optional Pyroscope for continuous profiling | Taken during every load-test step |
| **Ground truth** | Real misses, duplicates and true latency | Scorer vs the simulator's answer key | Unique to this project: production systems can only estimate these |

Everything runs in `docker compose`: OTel Collector, Prometheus, Grafana, Jaeger (Loki and Pyroscope optional). Dashboards and alert rules are files in the repo (`dashboards/`, `alerts/`), not clicked together by hand.

## 3. The key measurement: post-to-alert latency, broken into parts

Total latency alone can't tell you what to fix. Every alert records five timestamps, so the total splits into four parts:

```
posted ──── discovery ────▶ fetched ── processing ──▶ enqueued ── queue wait ──▶ sent ── send ──▶ accepted
(board)   (waiting for the     (poll        (normalize,      (alert         (waiting for     (notifier   (Telegram
           next poll)          returned)    dedup, match)    queued)        Telegram tokens)  request)    said 200)
```

| Part | Expected size | Driven by | If it grows, look at |
| --- | --- | --- | --- |
| **Discovery** = fetched − posted | seconds to minutes | **poll interval** for that lane (about half the interval on average) | budget allocation, 429 pauses, HTTP pool wait, scheduler stretch |
| **Processing** = enqueued − fetched | milliseconds | CPU | event-loop lag, stage queue waits, match fan-out |
| **Queue wait** = sent − enqueued | ~0, seconds under load | Telegram limits | alert queue age, digest rate, bots |
| **Send** = accepted − sent | ~100–300 ms | Telegram / network | Telegram latency and 429s |

**Expect discovery to dominate**, because polling every 5–60 seconds dwarfs milliseconds of processing. That's the design's main lever: the budget allocation rule (LLD 6.3) exists to shrink discovery where it matters. The dashboard shows the four parts stacked, per lane heat, so the biggest part is obvious.

**Ground truth caveat:** "posted" is the board's own timestamp. The simulator also knows the true posting time, so the scorer checks the board clock against it. This makes clock skew visible instead of silently corrupting latency.

## 4. Methods: RED for stages, USE for resources

**RED per stage** (Rate, Errors, Duration), for poll, normalize, dedup, match, alert and deliver:

```
stage_items_total{stage}                 rate of items processed
stage_errors_total{stage,reason}         errors by reason
stage_duration_seconds{stage}            time to process one item (histogram)
stage_queue_depth{stage}                 items waiting in front of the stage
stage_queue_wait_seconds{stage}          time an item waits before the stage picks it up (histogram)
```

**USE per resource** (Utilization, Saturation, Errors), so a load test can say *which* resource ran out:

| Resource | Utilization | Saturation (the early warning) | Errors |
| --- | --- | --- | --- |
| CPU / event loop | `nodejs_eventloop_utilization` | `nodejs_eventloop_lag_seconds` (p99) | — |
| Heap | `heap_used_bytes` / limit | `nodejs_gc_duration_seconds` (pause time) | OOM restarts |
| HTTP pool per board | `http_sockets_in_use{board}` / pool size | **`http_pool_wait_seconds{board}`** | `upstream_requests_total{status="timeout"}` |
| Login budgets | `budget_used_ratio{board}` (across logins) | `scheduler_stretch_factor`, entries waiting for tokens | `upstream_requests_total{status="429"}`, pauses, bans |
| Stage queues | `stage_queue_depth / capacity` | `stage_queue_wait_seconds` | `stage_queue_full_total` (producer had to wait) |
| Telegram | `telegram_sent_total` / 30 per bot per s | `alert_queue_oldest_seconds` | `telegram_429_total` |
| Disk (snapshots) | `snapshot_bytes` | `snapshot_duration_seconds` vs the 5 s interval | `snapshot_failures_total` |

**Saturation comes before failure.** Pool wait, event-loop lag and queue age rise before latency SLOs break, so they're where alerts and load-test analysis look first.

## 5. Metrics catalog

Prometheus histograms need bucket boundaries chosen up front; they're listed here.

| Metric | Type | Labels | Buckets / notes |
| --- | --- | --- | --- |
| `post_to_alert_seconds` | histogram | `lane_heat` (hot, warm, cold) | 1, 2, 5, 10, 20, 30, 60, 120, 300, 600. SLO metric, with trace exemplars |
| `latency_part_seconds` | histogram | `part` (discovery, processing, queue_wait, send), `lane_heat` | 0.001 … 600, log-spaced |
| `upstream_requests_total` | counter | `board`, `status` (200, 429, 403, 5xx, timeout) | |
| `upstream_request_seconds` | histogram | `board` | board response time, *excluding* pool wait |
| `http_pool_wait_seconds` | histogram | `board` | 0.001 … 5 |
| `http_sockets_in_use` | gauge | `board` | |
| `login_paused_total`, `login_banned_total` | counter | `board` | banned must stay 0 |
| `budget_used_ratio` | gauge | `board` | requests made / requests allowed, all logins |
| `poll_freshness_seconds` | histogram | `lane_heat` | age of the newest data per plan entry |
| `postings_per_poll` | histogram | `board` | 0 means a wasted request |
| `alerts_per_upstream_request` | gauge | — | value per unit of budget, the efficiency number |
| `normalize_unknown_total` | counter | `board`, `kind` (place, equipment) | spikes = a board changed its format |
| `dedup_total` | counter | `stage`, `result` (refresh, updated, merged, new) | |
| `dedup_score` | histogram | — | classifier scores; drift shows as a shape change |
| `match_fanout` | histogram | — | candidates per load: 1, 10, 100, 1K, 10K |
| `matches_per_load` | histogram | — | users alerted per load |
| `alert_queue_depth`, `alert_queue_oldest_seconds` | gauge | — | |
| `alert_queue_mode` | gauge | — | 0 = oldest first, 1 = freshest first |
| `alerts_dropped_stale_total` | counter | — | |
| `telegram_sent_total`, `telegram_429_total`, `telegram_digest_size` | counter / histogram | — | |
| stage RED + USE metrics | | | section 4 |
| `llm_calls_total`, `llm_latency_seconds`, `llm_tokens_total`, `llm_cost_usd_total` | | `result`, `kind` | parser only |
| `build_info` | gauge | `git_sha`, `config_hash` | lets every graph be tied to a version and config |

**Cardinality rules:**
- **Never** label by user, credential, search, load or chat. At 1000x that's millions of series, which takes down Prometheus. Per-credential detail goes in logs and traces.
- `lane_heat` is three buckets, not a cell id.
- When per-credential views are needed ("which logins get the most 429s?"), compute a top-10 from logs, or export only the top-k as a separate small metric.

## 6. Traces

- **One trace per posting**, from `poll` to `deliver`. Context travels with the item through the in-memory queues.
- **Spans and attributes:**

| Span | Attributes |
| --- | --- |
| `poll` | `board`, `lane_heat`, `status`, `postings_returned`, `pool_wait_ms` (no credential id in attributes; it goes in logs) |
| `normalize` | `board`, `result` |
| `dedup` | `stage`, `result`, `candidates`, `score` |
| `match` | `candidates`, `matched_users` |
| `deliver` | `queue_mode`, `queue_wait_ms`, `digest_size`, `post_to_alert_ms`, and the four latency parts |

- **Exemplars:** each `post_to_alert_seconds` observation carries its `trace_id`. In Grafana, clicking a slow point on the latency graph opens that exact trace. (Prometheus needs `--enable-feature=exemplar-storage` and OpenMetrics format.)
- **Looking up one load:** the canonical load id and board ids are span attributes, so "why was load X late?" is one Jaeger search.

## 7. Sampling: what we keep at scale

Measured, not assumed: see [bench/overhead/RESULTS.md](bench/overhead/RESULTS.md) (pinned Linux core, 5 runs per mode, ±1.4% noise floor).

| Approach | Measured CPU overhead | Verdict |
| --- | --- | --- |
| Metrics, per item (counters and timings for every posting) | +3.6–5.0% | Replaced |
| **Metrics, lite** (counters flushed per batch, stage timings for 1 posting in 16) | **≈ 0% (within noise)** | **Chosen** |
| SDK head sampling 1%, 5 spans per posting | +17.9% | Rejected: the SDK does work for every unsampled span |
| Our code decides the 1% before calling the SDK | +6.5–6.8% total with per-item metrics | Chosen sampling method |
| **Lite metrics + our own 1% sampling (shipping configuration)** | **+1.0% total** | **Chosen: meets the < 5% target** |
| 100%, 5 spans per posting (what collector tail sampling needs) | +40.8%, **3.1% of spans silently dropped** | Rejected |
| 100%, 1 span per posting | +20.0%, no drops | Only for short debugging windows |

So the plan is:
- **Head sampling in our code**, 1% by default. The 99% that aren't sampled never touch the tracing SDK.
- **Slow or failed postings are still recorded:** the timings are always measured for metrics anyway, so when a posting turns out slow (> SLO) or fails, one span is created after the fact with those timings. That captures what tail sampling would, without exporting 100%.
- **One span per posting**, stage timings as attributes. Child spans per stage only in a debug mode.
- **No collector tail sampling at scale:** it makes the app export everything, measured at +20–40% CPU.
- **Exporter health is monitored:** `spans_dropped_total` with an alert above zero, and the queue sized for the peak span rate. Drops are otherwise only a log line.
- **Metric counters are never sampled,** and post-to-alert latency is recorded for every alert, so SLOs stay exact. Only the per-stage duration histograms use 1 posting in 16.

## 8. Logs

Structured JSON, one event per line, with fixed fields: `ts`, `level`, `event`, `trace_id`, plus event fields. Not one line per posting; the volume would be huge. Only events worth reading:

| Event | Level | Fields |
| --- | --- | --- |
| `login.paused`, `login.circuit_open`, `login.banned` | warn / error | credential id, board, consecutive 429s, paused until |
| `normalize.unknown_place` | warn (rate-limited) | board, raw city and state |
| `alert.dropped_stale` | info | canonical id, age |
| `snapshot.failed` | error | error |
| `llm.call` | info | model, prompt, output, tokens, latency, cost, valid (LLD 10.3) |
| `plan.rebuilt` | info | user id, entries before and after, merge ratio |

Board passwords and tokens are never logged. A log-redaction test checks this.

## 8b. LLM observability (built and verified)

Requirement: for every LLM call, see the prompt sent, the model, the output, token usage and latency.

```
model call ──► one OpenTelemetry span, GenAI conventions (src/obs/llm.ts) ──► OTel Collector ─┬─► Langfuse  :3001  prompt, output, tokens, latency, eval scores
                                                                                              ├─► Jaeger    :16686 the call inside its trace
                                                                                              └─► Prometheus       llm_calls_total, llm_duration_* (span metrics)
```

- **Instrument once, route in config.** Every model call (GLiNER2, Qwen via Ollama, any future LLM) goes through `traceLlmCall()`, which records `gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name`, request parameters (e.g. temperature), `gen_ai.usage.input_tokens` / `output_tokens`, the exact input (`langfuse.observation.input`: messages, schema) and the raw output (`langfuse.observation.output`), plus errors. Swapping Langfuse for LangSmith or Phoenix is a collector change, not a code change.
- **Collector routing** (`ops/otel-collector.yaml`): all spans go to Jaeger. A second pipeline keeps only spans with `gen_ai.request.model` and sends them to Langfuse (OTLP/HTTP, header `x-langfuse-ingestion-version: 4` for real-time ingestion) and to the `spanmetrics` connector, which turns them into Prometheus metrics with no app code.
- **Langfuse is self-hosted** (v4, in `docker-compose.yml`, secrets in `.env`). Calls are grouped by session (`eval-<run>-<contender>`, `cli`) and tagged with metadata (contender, example kind).
- **Evals attach to calls:** `ml/parser/eval.ts` posts `eval_all_correct` and `eval_fields_correct` scores to the exact Langfuse observation that produced each answer, so a wrong answer is one click from the prompt and output that caused it.
- **Verified** (2026-11-04): a Qwen call shows the full system and user messages, the raw JSON reply, 143 input / 50 output tokens, temperature 0 and 2.47 s; a GLiNER2 call shows the text and schema in, the spans with confidences out, 133 ms. The eval run produced 88 traced calls and 168 scores (0 failed); Prometheus counted 44 calls per model.
- **Gotchas found:** span metrics are flushed about once a minute, so new calls appear in Prometheus with up to ~60 s delay; Prometheus labels the calling service `exported_job` / `service_name` (its own `job` label is the scrape job); Langfuse v4 removed the old `/api/public/traces` read endpoint (use `/api/public/v2/observations` or the UI).

## 9. Measuring performance: load-test protocol

Each run follows the same steps, so results are comparable:

1. **Record the setup:** git sha, config hash, generator flags and seed, machine (CPU, RAM, Node version).
2. **Warm up** for 2 minutes. Discard.
3. **Step the load up:** e.g. users × 1, 2, 4, 8, 16… holding each step for 5 minutes.
4. **At each step, capture:**
   - SLO metrics: post-to-alert p50/p95/p99, freshness, misses and duplicates (scorer)
   - the four latency parts
   - USE for each resource (section 4)
   - a 30-second CPU profile
5. **Find the knee:** the first step where an SLO fails. Record **which resource saturated first** (its saturation signal rose earliest) and the profile's top functions.
6. **Fix one thing, rerun the same steps,** and compare. Before/after pairs go into `SCALING.md`.

**The runs** (from DESIGN.md, plus observability-specific ones):

| Run | What it shows |
| --- | --- |
| Baseline | SLOs pass; the latency breakdown is mostly discovery |
| Users step-up | The knee and its saturated resource |
| Hot-lane burst (`--burst`) | Match fan-out and Telegram queueing; queue switches to freshest first |
| Board slow / 429s | Backoff works; other boards unaffected; zero bans |
| **Undersized HTTP pool (64 sockets)** | Pool wait rises while board latency stays flat: the silent limit made visible |
| Kill and restart | Misses and duplicates caused by the restart (snapshot interval) |
| **Observability overhead** | Same run with tracing at 100%, 1% and off. Target: instrumentation costs < 5% CPU. **Done, see [bench/overhead/RESULTS.md](bench/overhead/RESULTS.md)**: run pinned on Linux, because the laptop's ±10% noise hides 5% effects |

**Results table template** (one row per step, in `SCALING.md`):

```
| step | users | upstream req/s | postings/s | p95 latency (hot) | discovery share | misses | dups | first saturated | profile top |
```

## 10. Dashboards

**1. Overview (the one that's open during every test)**
- **Row 1, customer:** post-to-alert p50/p95/p99 by lane heat with exemplars; SLO burn rate; misses and duplicates (from the last scorer run); bans.
- **Row 2, where time goes:** the four latency parts, stacked, by lane heat.
- **Row 3, sources:** requests by board and status; pool wait vs board response time on the same graph (the pool signature); budget used; paused logins; freshness.
- **Row 4, engine:** RED per stage; queue depth and wait per stage; event-loop lag; heap and GC pauses.
- **Row 5, delivery:** alert queue depth and oldest age; queue mode; stale drops; Telegram sends, 429s, digest sizes.

**2. Load test** — the same panels, with annotations at each load step and run boundary, plus the `build_info` version.

**3. Parser and LLM** — calls, rules-vs-LLM share, validation failures, tokens, cost, latency, and "fields the user corrected" as the real accuracy signal.

## 11. Alerts

SLO alerts use **multi-window burn rates** (the Google SRE Workbook method): page only when the error budget is burning fast over both a long and a short window. A short spike doesn't page anyone, and a slow leak still gets caught.

| Alert | Condition | Severity |
| --- | --- | --- |
| Latency SLO, fast burn | burn rate > 14.4 over 1 h **and** over 5 min (2% of a 30-day budget in an hour) | page |
| Latency SLO, slow burn | burn rate > 6 over 6 h **and** over 30 min | page |
| Latency SLO, leak | burn rate > 1 over 3 days | ticket |
| Any ban | `increase(login_banned_total[5m]) > 0` | page |
| Pool saturated | `http_pool_wait_seconds` p95 > 0.5 s for 5 min | page |
| Event loop saturated | event-loop lag p99 > 200 ms for 5 min | ticket (page if latency also burns) |
| Delivery falling behind | `alert_queue_oldest_seconds` > 30 s for 5 min | page |
| Board format changed | `normalize_unknown_total` rate > 5× its weekly baseline | ticket |
| Snapshots failing | `snapshot_failures_total` increases, or snapshot age > 30 s | ticket |
| Telegram throttling | `telegram_429_total` rate > 1/s for 10 min | ticket |

Each alert links to a runbook (section 12) and to the relevant dashboard row.

## 12. Runbooks: symptom → panel → cause → action

| Symptom | Check | Likely cause | Action |
| --- | --- | --- | --- |
| Latency up, **discovery** part grew | Budget used, 429s, scheduler stretch | Budgets exhausted or logins paused | Better query merging; reallocate budget to hot lanes; shared feeds |
| Latency up, board response time flat, **pool wait** up | Pool panel | HTTP pool too small | Resize by Little's law |
| Latency up, **processing** part grew | Event-loop lag, stage queue waits, CPU profile | One core saturated | Profile; worker threads by `credentialId` |
| Latency up, **queue wait** part grew | Alert queue age, Telegram 429s | Delivery limit (hot load) | Digests, more bots, push channel |
| Misses up, latency fine | Scorer misses by reason; dedup merges; unknown places | Classifier over-merging or adapter dropping postings | Raise the merge threshold; fix the adapter |
| Duplicates up | `dedup_total{result="new"}` share; restart events | Classifier under-merging, or a restart lost the alerted set | Lower the threshold; check snapshots |
| 429s rising on one board | Logs: top logins by 429s | Budget assumption wrong for that board | Lower that board's budget |
| Memory climbing | Heap, GC pauses, sizes of the in-memory maps | Eviction not running, or state outgrew one process | Check hourly bucket drops; partition |

## 13. Implementation plan

| Step | Work | When |
| --- | --- | --- |
| 1 | `docker compose` with the OTel Collector, Prometheus (exemplars on), Grafana (provisioned data sources), Jaeger | Day 1, first hour |
| 2 | `src/shared/otel.ts`: SDK setup, `prom-client` default metrics (event loop, GC, heap), a `stage()` helper that wraps every stage with RED metrics, queue metrics and a span | Day 1, with the first stage |
| 3 | Latency timestamps carried on every item; the deliver step records the four parts and the exemplar | Day 1, end to end |
| 4 | Overview dashboard as JSON in `dashboards/` | Day 2 morning |
| 5 | Scorer writes misses, duplicates and true latency, and pushes summary numbers as metrics | Day 2 |
| 6 | Alert rules in `alerts/` + runbook links | Day 2 (after the dashboard) |
| 7 | Load-test runs with profiles + overhead run → `SCALING.md` | Day 2 afternoon |

**Cut if behind:** Loki and Pyroscope (use files and `--cpu-prof`), alert rules (keep the burn-rate panel). **Never cut:** the latency breakdown, pool wait vs board latency, USE saturation signals, and the scorer. Those carry the "what breaks first" story.

**Design rule for the code:** every stage goes through the same `stage()` wrapper, so no stage can ship without its metrics and span.
