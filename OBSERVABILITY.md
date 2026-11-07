# Load Radar: observability

How we see problems, measure performance, and know the system works. [DESIGN.md](DESIGN.md) says what the system
does; [LLD.md](LLD.md) says how. This says how we **know** it's working.

## 1. Signals and tools

| Signal | Use it for | Tool |
| --- | --- | --- |
| **Metrics** | Trends, SLOs, alerts, capacity | `prom-client` → Prometheus → Grafana |
| **Traces** | Following one load, or one API request, through every stage | OpenTelemetry SDK → OTel Collector → Tempo → Grafana |
| **Logs** | Rare events with detail: bans, circuit opens, unknown places, model calls, every live-mode API call | `src/obs/log.ts`: JSON to stdout, and over OTLP → OTel Collector → Loki → Grafana |
| **Profiles** | Why CPU or memory is high | `node --cpu-prof` + flame graphs; heap snapshots, taken during load-test steps |
| **Ground truth** | Real misses, duplicates and true latency | Scorer vs. the simulator's answer key (`scorer/score.ts` batch, `live/score.ts` live, rolling) |

Everything runs in `docker compose`: the OTel Collector, Tempo, Loki, Prometheus, Grafana, self-hosted Langfuse
(v4), plus the models (GLiNER2, Ollama) the search parser and agent call. No Jaeger, no Pyroscope: Grafana reads
Tempo and Loki directly, and profiling is ad hoc rather than continuous. The dashboard is provisioned as code
(`ops/grafana/dashboards/load-radar.json`).

## 2. The key measurement: post-to-alert latency

Every alert records five timestamps, splitting total latency into four parts:

```
posted ──── discovery ────▶ fetched ── processing ──▶ enqueued ── queue wait ──▶ sent ── send ──▶ accepted
(board)   (waiting for the     (poll        (normalize,      (alert         (waiting for     (notifier   (channel
           next poll)          returned)    dedup, match)    queued)        send tokens)     request)    said 200)
```

| Part | Expected size | Driven by |
| --- | --- | --- |
| **Discovery** = fetched − posted | seconds to minutes | poll interval for that lane |
| **Processing** = enqueued − fetched | milliseconds | CPU |
| **Queue wait** = sent − enqueued | ~0, seconds under load | alert channel limits |
| **Send** = accepted − sent | ~100–300 ms | alert channel / network |

Discovery normally dominates: polling every 5–60 s dwarfs milliseconds of processing. Stage timings ride along as
attributes on the posting's trace (section 4), not as a separate per-part Prometheus metric. "Posted" is the
board's own timestamp; the simulator also knows the true posting time, so the scorer checks the board clock
against it, which makes clock skew visible instead of silently corrupting latency.

## 3. Metrics

Prometheus scrapes `live` and the batch `app` (engine metrics, `:9464`) and `live/server.ts`'s own API (`:8080`),
plus the engine cluster when it's running: `cluster-engine` and `cluster-engine-api` (every `engine` replica,
`:9464`/`:8080`, found by Docker DNS), `cluster-world` (`:9464`) and `cluster-dispatchers` (`:9464`).

| Metric | Type | Source |
| --- | --- | --- |
| `post_to_alert_seconds` | histogram | engine — the SLO 1 metric, with trace exemplars |
| `stage_duration_seconds{stage}`, `stage_items_total{stage}` | histogram / counter | engine — RED per stage (normalize, dedup, match, alert); duration sampled 1 posting in 16 |
| `stage_queue_wait_seconds{queue}`, `queue_overflow_total{queue}` | histogram / counter | engine |
| `upstream_requests_total{board,status}`, `upstream_request_seconds{board}` | counter / histogram | engine — board requests and response time |
| `http_pool_wait_seconds{board}` | histogram | engine — saturation signal for the HTTP pool |
| `dedup_total{result}` (new/merged/refresh/updated), `match_fanout` | counter / histogram | engine |
| `normalize_failed_total{board,reason}` | counter | engine |
| `engine_gauge{name}` | gauge | engine — one gauge, many names: `poll_queue`, `raw_queue`, `alert_queue`, `alert_queue_oldest_wait_ms`, `polls_waiting_for_login`, `polls_coalesced`, `polls_in_flight`, `logins_busy`, `logins_paused`, `logins_banned`, `scheduler_stretch`, `alerts_dropped_stale`, `notifier_held`, `notifier_dropped_stale` |
| `spans_dropped_total` | counter | engine — exporter queue health |
| `answer_key_settled_total{outcome}` (delivered/missed_open/missed_quick), `answer_key_other_total{kind}` (late/duplicate/unexpected/backfill), `answer_key_pending` | counter / gauge | `live/server.ts` and `cluster-world` — SLO 2 ground truth |
| `world_eventloop_lag_p99_seconds` | gauge | `live/server.ts` and `cluster-world` — the world thread/container (boards, alert channel, answer key) |
| `llm_calls_total`, `llm_duration_milliseconds_*` | counter / histogram | no app code — the OTel Collector's `spanmetrics` connector, built from GenAI spans (section 6) |
| `engine_api_requests_total{route,status}`, `engine_dispatchers_owned` | counter / gauge | `cluster/engine.ts` — each replica's dispatcher API |
| `dispatcher_api_requests_total{route,status}`, `dispatcher_api_seconds{route}` | counter / histogram | `cluster/dispatchers.ts` — the cluster test's own API calls |
| `boards_banned_logins`, `boards_rejected_total` | gauge | `cluster/world.ts` — bans and 429s the boards simulator has issued |
| Node defaults (`nodejs_eventloop_lag_*`, `process_cpu_seconds_total`, heap, GC) | — | `prom-client`'s `collectDefaultMetrics`, every process |

**Cardinality rule:** never label by user, credential, search, load or chat — per-credential detail goes in logs
and traces instead.

**Planned, not built:** per-login pause/ban log lines, a `normalize.unknown_place` log event, a dedicated
latency-by-part metric, poll-freshness and alerts-per-request efficiency metrics, Grafana panels for the engine
cluster.

## 4. Traces

One trace per posting, from `poll` to `deliver`, plus one per API request (search parsing, the agent). Context
travels with the item through the in-memory queues.

| Span | Attributes |
| --- | --- |
| `poll` | `board`, `status`, `postings_returned`, `pool_wait_ms` (no credential id — that goes in logs) |
| `normalize` | `board`, `result` |
| `dedup` | `result`, `candidates`, `score` |
| `match` | `candidates`, `matched_users` |
| `deliver` | `queue_mode`, `queue_wait_ms`, `digest_size`, `post_to_alert_ms`, the four latency parts |

**Exemplars:** each `post_to_alert_seconds` observation carries its `trace_id`, so a slow point on the Grafana
latency graph opens that exact trace in Tempo (`--enable-feature=exemplar-storage`, OpenMetrics format). From
there, "Logs for this span" (Tempo's `tracesToLogsV2`) pivots to Loki filtered to that `trace_id`. A model-call
span (GLiNER2 or Qwen) carries `gen_ai.request.model`; the same call is also in Langfuse (section 6).

**Sampling:** our code decides 1% head sampling before calling the SDK — the measured cheapest approach (see
`bench/overhead/RESULTS.md`). A posting that turns out slow or failed is recorded anyway, after the fact. One span
per posting, with stage timings as attributes. Measured total overhead: **+1.0% CPU**.

## 5. Logs

Structured JSON, one event per line (`src/obs/log.ts`): `ts`, `level`, `event`, `trace_id`/`span_id` when a span is
active, plus call-specific attributes. Not one line per posting — the engine's hot path emits only metrics and
sampled spans. Everything logged today comes from `live/server.ts`:

| Event | Fields |
| --- | --- |
| `live.started` | port, seed, user count, speed |
| `search.parsed` | text, summary, model call count, questions asked, fallback |
| `search.saved` / `search.removed` | search id, summary / `alerts_cancelled` |
| `alert.sent` | user, load id, latency, expected, late, backfill, alert text |
| `control.speed` / `control.volume` / `control.burst` | the new speed / loads-per-day / burst parameters |
| `parse.model_unavailable` | error (hybrid mode fell back to rules-only) |
| `api.error` | path, error |

Board passwords and tokens are never logged — a code-review rule, not an enforced check (there are no automated
tests in this project).

## 6. LLM observability

Every model call (GLiNER2, Qwen via Ollama) goes through `traceLlmCall()` (`src/obs/llm.ts`): a GenAI-convention
span with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name`, request parameters, token usage, the
exact input, the raw output, and errors.

```
model call / agent run / tool call ──► OTel spans (GenAI conventions) ──► OTel Collector ──┬─ traces ──────► Tempo
                                                                                            ├─ traces/genai ► Langfuse
                                                                                            └─ traces/llm ──► spanmetrics ─► Prometheus
```

The `traces/genai` pipeline (`ops/otel-collector.yaml`) filters to spans with `gen_ai.request.model` set and sends
them to self-hosted Langfuse (v4: `langfuse-web`/`worker`/`postgres`/`clickhouse`/`redis`/`minio`), where an agent
run appears as one trace: agent → model calls → tool calls. The `traces/llm` pipeline feeds the `spanmetrics`
connector, so `llm_calls_total` counts model calls only, not tool calls. Evals (`ml/parser/eval.ts`) attach
correctness scores to the Langfuse observation that produced each answer.

Verified: a Qwen call shows the full messages, the raw JSON reply, token counts, temperature and latency; a
GLiNER2 call shows the text/schema in and spans with confidences out. Span metrics flush to Prometheus with up to
~60 s delay.

## 7. Dashboards

**Built** — "Load Radar" (`ops/grafana/dashboards/load-radar.json`), provisioned as code, set as the server's
default home dashboard, refreshes every 10 s, last 30 minutes by default:

- **SLOs** (last hour): each SLI vs. target, budget left, burn rate.
- **Right now**: board requests/s, postings/s, new loads/s, alerts sent/s, post → alert p95, logins banned.
- **Throughput**, **Latency** (post → alert, board request time, stage time), **Health** (queue depths,
  paused/banned logins, drops), **Models** (LLM calls/s, latency p95), and a **traces + logs** table for recent
  API requests.

**Not built:** panels for the engine cluster; a fuller per-lane, per-resource load-test view.

## 8. Alerts

`ops/prometheus-rules.yml`, evaluated by Prometheus, visible at `http://localhost:9090/alerts`. There's no
Alertmanager, so a "page" here means the rule fires and shows red in Grafana, not an actual page.

| Alert | Condition | Severity |
| --- | --- | --- |
| `AlertLatencyBudgetFastBurn` | burn rate on SLO 1 > 10 over 5 min **and** over 1 min | page |
| `AlertCompletenessBudgetFastBurn` | burn rate on SLO 2 > 10 over 5 min **and** over 1 min | page |
| `BoardLoginBanned` | any login banned | page |
| `BoardRateLimitedTooOften` | over 5% of board requests 429, for 2 min | ticket |
| `EngineSaturated` | event-loop p99 > 100 ms and CPU > 0.9 core, for 2 min | ticket — warns before SLO 1 burns |

**Not built:** a slow-burn SLO alert, an alert on failed deploys, a health check from outside the box.
