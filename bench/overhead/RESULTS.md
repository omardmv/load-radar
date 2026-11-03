# Observability overhead: results

Question (from [OBSERVABILITY.md](../../OBSERVABILITY.md)): does observability cost under 5% CPU?
**Answer: not by default, yes after three changes.** As usually written, metrics cost +3.6–5.0%, and tracing costs +18% at 1% sampling and +41% at 100% (with spans dropped). With lighter metrics, sampling decided in our code, and one span per posting, **the configuration we'd ship (metrics + 1% tracing) costs +1.0%** (section "The fix that got under 5%").

## What was measured

- **Workload:** the engine's CPU core (normalize → dedup → match → alert, all in memory; `core.ts`), replaying `postings.ndjson` (seed 1, 100K loads) at a fixed **5,000 postings/s**. Board HTTP isn't included, so this measures our code plus observability only.
- **Entitlement applied:** 90% of postings alert only the customer whose login fetched them; 10% are shared feeds (visible to all).
- **Per run:** a fresh process, 5 s warm-up, 30 s measured. CPU time from `process.cpuUsage()` ÷ postings processed = **CPU µs per posting**.
- **Repeats:** 5 per mode, with mode order rotated between repeats.
- **Spans** go over OTLP/HTTP (JSON) to a sink in a separate process pinned to another core (stands in for the OTel Collector). Dropped spans are counted from the SDK's own "Dropped N spans" warning.

## Environment matters: the noise floor

| Machine | "none" vs. itself (5 runs) | Spread |
| --- | --- | --- |
| MacBook (M4 Pro), unpinned | 51.0–63.9 µs | ±10%: too noisy to judge a 5% target |
| **Linux server (Ryzen 7 3700U, Ubuntu 24.04), Docker `node:26-slim`, pinned to CPU 4 (its twin thread idle)** | **102.7–105.6 µs** | **±1.4%** |

The Mac has fast and slow cores and macOS doesn't allow pinning, so runs land on different cores. On Linux with identical cores, pinning one core removes most of the noise. CPU frequency was left on its default (`schedutil`, boost on); fixing it would tighten this further but wasn't needed. All numbers below are from the server.

## Results (server, 5 runs per mode)

| Mode | What it does | CPU µs/posting, median (min–max) | Overhead vs. none | Core busy | Event-loop delay p99 | Spans dropped |
| --- | --- | --- | --- | --- | --- | --- |
| `none` | nothing | 105.3 (104.8–106.3) | — | 53% | 34 ms | — |
| `metrics` | RED metrics per stage + default Node metrics | 110.6 (109.7–111.4) | **+5.0%** | 55% | 34 ms | — |
| `trace1` | metrics + tracing, 1% head sampling, 5 spans per posting | 124.2 (122.2–125.3) | **+17.9%** | 62% | 54 ms | 0 |
| `trace1lazy` | as above, stage spans only when the root is sampled | 119.2 (117.8–120.0) | +13.2% | 60% | 53 ms | 0 |
| `trace1self` | **we decide the 1% before calling the SDK**; 99% of postings never touch it | 112.5 (111.9–113.7) | **+6.8%** (+1.8% over metrics) | 56% | 36 ms | 0 |
| `trace100` | metrics + tracing every posting, 5 spans each | 148.2 (145.9–149.6) | **+40.8%** | 74% | 74 ms | **24,754 (3.1%)** |
| `trace100flat` | every posting, **1 span** with stage timings as attributes | 126.4 (125.2–127.0) | +20.0% | 63% | 42 ms | 0 |

The Mac runs (noisier) agreed on the direction: `results/fixed-rate.jsonl`, `results/fixes.jsonl`. Raw server data: `results/server.jsonl`.

## The fix that got under 5%

Second run on the same pinned server core, 5 runs per mode (`results/server-metrics.jsonl`):

| Mode | What it does | CPU µs/posting, median (min–max) | Overhead vs. none |
| --- | --- | --- | --- |
| `none` | nothing | 106.5 (104.9–107.0) | — |
| `metrics` | RED metrics, every posting | 110.3 (110.0–111.5) | +3.6% |
| `metricslite` | counters kept as plain numbers and added to prom-client **once per batch**; stage timings for **1 posting in 16** | 106.4 (106.1–108.0) | **−0.1%** (within noise) |
| `trace1self` | metrics + our own 1% sampling | 113.4 (112.0–113.8) | +6.5% |
| **`trace1selflite`** | **lite metrics + our own 1% sampling: the shipping configuration** | **107.6 (106.6–107.9)** | **+1.0%** |

Notes:
- Plain `metrics` measured +5.0% in the first session and +3.6% here. The difference is within run-to-run variation between sessions, about ±1.5%. Within one session, the ordering is consistent.
- What lite metrics give up: the stage-duration histograms come from 1 in 16 postings. At 5,000 postings/s that's still about 300 samples a second per stage, plenty for p50/p99. Counters (rates, dedup results) stay exact. Posting-level latency (posted → alert) is measured on every alert, from timestamps, and isn't sampled.
- Sampled postings (the 1%) are always fully timed, so every exported trace has complete stage timings.

## What we learned

1. **Unsampled spans aren't free.** With 1% sampling, the OpenTelemetry SDK still does work for every span of every posting: it generates IDs, runs the sampler, sanitizes attributes and updates its own metrics, then returns an empty span (`sdk-trace/build/src/Tracer.js`, `startSpan`). Five spans per posting × 100% of postings is where the 1% mode's +18% comes from.
2. **Deciding sampling before touching the SDK is the big fix:** +17.9% → +6.8%, which is only +1.8% on top of metrics. Creating child spans only when the root is sampled (`lazy`) helps less (+13.2%), because the unsampled root span still pays the full cost.
3. **Span count is the cost driver at 100%.** One span per posting with stage timings as attributes halves the overhead (+40.8% → +20.0%) and removes the drops.
4. **Silent span loss.** At 100% with 5 spans per posting (25,000 spans/s), the exporter's queue (2,048 by default) overflowed and dropped 3.1% of spans. It only logs a warning, and it happens exactly when the system is busiest. On the faster Mac it never happened, so the problem only showed up on weaker hardware.
5. **Exporting blocks the event loop.** Event-loop delay p99 doubled at 100% (34 → 74 ms): serializing span batches to JSON runs on the same thread as the pipeline. That delay adds directly to post-to-alert latency.
6. **Tail sampling isn't free for the app.** Collector-side tail sampling ("keep errors and slow traces") needs the app to export **100%** of spans. The trace store saves money, but the app pays the `trace100` cost: +20% at best here.
7. **Per-item metrics are the hidden cost, not the metrics system.** A `performance.now()` pair, a histogram observation and a counter increment per stage, four stages per posting, cost +3.6–5.0%. Counting in plain numbers, flushing per batch and timing 1 in 16 brought it to noise level.

## Decisions for the design

| Decision | Why |
| --- | --- |
| Head sampling is decided **by our code before the SDK**, 1% by default; slow or failed postings are force-recorded at the end (a single span created after the fact, with the measured timings) | +1.8% CPU for tracing, and errors and slow cases are still captured without app-wide 100% export |
| **One span per posting**, stage timings as attributes; child spans only in a debug mode | Span count drives cost and drops |
| **No collector tail sampling at scale** unless the 100% export cost is acceptable | It costs the app +20–40% CPU |
| Exporter queue sized for the peak span rate, a `spans_dropped_total` metric, and an alert when it's above zero | Drops are silent otherwise |
| Export in a worker thread, or OTLP protobuf instead of JSON, if event-loop delay matters | The export work currently shares the pipeline's thread |
| Metrics: counters as plain numbers flushed **per batch**; stage timings for **1 posting in 16**; post-to-alert latency on every alert | Measured: metrics at noise level, shipping config at +1.0% |
| Benchmarks run **pinned on Linux**; the noise floor is measured first and reported with every result | The laptop's ±10% hides 5% effects |

## Not yet measured

- The "record slow or failed postings after the fact" span path.
- Protobuf export, and export in a worker thread.
- Board HTTP and JSON parsing of real responses: including them makes the engine's CPU larger, so the overhead *percentage* would shrink.
