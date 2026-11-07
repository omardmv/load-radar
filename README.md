# Load Radar

**Load Radar watches US truckload boards for a dispatcher and alerts them the moment a load matching one of their
saved searches is posted, then helps decide whether to take it.** A dispatcher types a search in plain English
("reefer out of Fresno, nothing under $3"), and the system polls every board on that dispatcher's own logins
within each board's limits, recognizes the same load posted many times, matches it against thousands of saved
searches, and delivers one alert per real load within seconds.

The focus is on **backend/infrastructure** (scale, overload, observability) and **AI/ML** (a trained dedup
classifier, a search parser, a load-decision agent with evals). It runs on one Linux laptop, deploys itself on
every push, and can be tried live in a browser.

**New here? Read [GUIDE.md](GUIDE.md)** for the problem, the pipeline, the architecture and the machine learning,
explained from zero.

### What it consists of

| Part | What it does | Where |
| --- | --- | --- |
| **Engine** | Schedules polls per board login (budgets, back-off, one request in flight per login), normalizes each board's format, **dedups** (exact ids, then a trained classifier), **matches** against saved searches with a geohash index, and sends alerts | [src/](src/) |
| **Search parser** | Turns a typed search into a structured one: rules first, the **GLiNER2** model for what rules miss, questions instead of guesses | [src/parse/](src/parse/) |
| **Dedup classifier** | Logistic regression on 18 pair features, trained on 305K labeled pairs; scored in TypeScript (~130 ns/pair) | [src/dedup/](src/dedup/), [ml/dedup/](ml/dedup/) |
| **Load-decision agent** | "Should I take it?": a local LLM reads the broker's comments, code applies the dispatch policy (book / negotiate / ask / skip) | [src/agent/](src/agent/), [ml/agent/](ml/agent/) |
| **Simulated world** | A calibrated generator of loads, brokers, reposts and dispatchers, simulated load boards (rate limits, bans), a simulated web alert channel, and an **answer key** that scores every alert | [sim/](sim/), [sims/](sims/), [scorer/](scorer/) |
| **Live mode + UI** | An always-on world (new data every start) with a React/shadcn page: save searches, see alerts, ask the agent, watch the board firehose | [live/](live/), [ui/](ui/) |
| **Observability** | OpenTelemetry → Collector → Prometheus (metrics), Tempo (traces), Loki (logs), Langfuse (every model call); one Grafana dashboard | [ops/](ops/), [OBSERVABILITY.md](OBSERVABILITY.md) |
| **Deployment** | Docker Compose on one server; a cron pulls from GitHub and redeploys within a minute of a push; SSH tunnel to the Mac | [DEPLOY.md](DEPLOY.md) |

### Key results

- **Live, 300 dispatchers, 30 h:** 100% of alerts within 60 s (typical 2.7 s, p99 9.3 s); 0 bans and 0
  rate-limit responses in 33 million board requests; duplicates 0.03%. Completeness 96–97% (target 99%).
- **Capacity:** one engine thread serves ~2,000 dispatchers within every SLO, breaking between 2,000 and 5,000.
  Split into 2 **engine workers**, the same load got 1.77× the throughput (3,745 → 6,617 board requests/s), 0 bans.
- **Push feed** behind nginx (hash routing): 1 → 2 → 3 ingest workers (one core each) take 2,050 → 2,935 → 3,346
  postings/s; duplicate alerts 1.7–2.7%, vs 43% with round robin.
- **Dedup classifier:** 99.85% precision, 99.4% recall (27 wrong merges, 101 missed, on 61,122 held-out pairs).
  End to end: missed alerts 1.80%, duplicate alerts 0.00%.
- **Search parser:** 98% of test searches fully right with rules + GLiNER2.
- **Load-decision agent:** 88–100% right splitting the job (model reads comments, code decides), vs 21–42%
  letting a model decide everything.

See [SLO.md](SLO.md) and [ML.md](ML.md) for full numbers and methodology.

## Run it

Everything (live mode, models, observability, and the engine/simulators/eval on demand) runs in Docker Compose on
one Linux server; see [DEPLOY.md](DEPLOY.md).

```bash
docker compose up -d                                         # live mode + models + observability, restart on reboot
alias app='docker compose run --rm --use-aliases app'        # Node 26 container on the same network
app node sim/gen.ts --loads 8000 --users 300 --hours 2 --out out-small
app node scripts/run.ts --data out-small --speed 30 --minutes 3 --otlp http://otel-collector:4318/v1/traces
```

The last line printed is `RUN_RESULT {...}`: alerts expected vs delivered, misses, duplicates, latency (simulated
seconds), board stats (429s, bans) and engine counters. Also written to `out-small/run/result.json`.

From the Mac, the UIs open on localhost through the SSH tunnel: live UI :8080, Grafana :3000 (traces in Tempo,
logs in Loki, metrics in Prometheus, all linked), Langfuse :3001, Prometheus :9090.

## Read in this order

| # | Document | Read it for |
| --- | --- | --- |
| 1 | [GUIDE.md](GUIDE.md) | Everything from zero: problem, pipeline, simulator, architecture, stack, ML, SLOs, scaling, operations, glossary |
| 2 | [DESIGN.md](DESIGN.md) | High-level design: constraints, the architecture diagram, all 30 decisions with alternatives and trade-offs, what breaks at 1000× |
| 3 | [ML.md](ML.md) | Every model: data, features, training, thresholds, evals, limits, changelog |
| 4 | [SLO.md](SLO.md) | The three objectives, error budgets, burn-rate alerts, and every measurement (scale steps, overload, live reviews) |
| 5 | [LLD.md](LLD.md) | Low-level design: types, state, APIs, each component's algorithm, failure handling, verification, repo layout |
| 6 | [OBSERVABILITY.md](OBSERVABILITY.md) | Metrics catalog, traces and sampling, logs, LLM observability, dashboards, alerts, runbooks |
| 7 | [DEPLOY.md](DEPLOY.md) | Server setup, continuous deploy, the Mac tunnel |
| — | [sim/ASSUMPTIONS.md](sim/ASSUMPTIONS.md), [bench/overhead/RESULTS.md](bench/overhead/RESULTS.md) | Every number in the simulated world with its source; the observability-cost benchmark |
