# Load Radar

**Load Radar watches US truckload boards for a dispatcher and alerts them the moment a load matching one of their saved searches is posted, then helps decide whether to take it.** A dispatcher types a search in plain English ("reefer out of Fresno, nothing under $3"), and the system polls every board on that dispatcher's own logins within each board's limits, recognizes the same load posted many times, matches it against thousands of saved searches, and delivers one alert per real load within seconds. Every part is measured against a written target (SLOs) and an answer key.

The focus is on **backend/infrastructure** (scale, overload, observability) and **AI/ML** (a trained dedup classifier, a search parser, a load-decision agent with evals). Everything runs on one Linux laptop, deploys itself on every push, and can be tried live in a browser.

**New here? Read [GUIDE.md](GUIDE.md).** It explains the problem, the solution, the architecture, the technology,
the machine learning, reliability and scalability from zero, one part at a time, with links into the detailed
documents. This page is the short version plus how to run it.

### What it consists of

| Part | What it does | Where |
| --- | --- | --- |
| **Engine** | The hot path: schedules polls per board login (budgets, back-off, one request in flight per login), normalizes each board's format, **dedups** (exact ids, then a trained classifier), **matches** against saved searches with a geohash index, and sends alerts (digests, rate limits, freshest first under load) | [src/](src/) |
| **Search parser** | Turns a typed search into a structured one: rules first, the **GLiNER2** model only for what rules miss, questions instead of guesses | [src/parse/](src/parse/) |
| **Dedup classifier** | Logistic regression on 18 pair features, trained on 305K labeled pairs; scored in TypeScript (~130 ns/pair) | [src/dedup/](src/dedup/), [ml/dedup/](ml/dedup/) |
| **Load-decision agent** | "Should I take it?": a local LLM reads the broker's comments, code applies the dispatch policy (book / negotiate / ask / skip); compared with a full tool-calling agent in evals | [src/agent/](src/agent/), [ml/agent/](ml/agent/) |
| **Simulated world** | A calibrated generator of loads, brokers, reposts, cross-posts and dispatchers (matched to DAT market data), plus simulated load boards (rate limits, bans) and Telegram, and an **answer key** that scores every alert | [sim/](sim/), [sims/](sims/), [scorer/](scorer/) |
| **Live mode + UI** | An always-on world (new data every start) with a React/shadcn page: save searches, see alerts, ask the agent, watch the board firehose, push speed and volume | [live/](live/), [ui/](ui/) |
| **Observability** | OpenTelemetry → Collector → Prometheus (metrics), Tempo (traces), Loki (logs), Langfuse (every model call); Grafana dashboard with SLOs, burn rates and saturation | [ops/](ops/), [OBSERVABILITY.md](OBSERVABILITY.md) |
| **Deployment** | Docker Compose on one server; a cron pulls from GitHub and redeploys within a minute of a push; SSH tunnel to the Mac | [DEPLOY.md](DEPLOY.md) |

### Measured so far

- **Live, 30 hours at real speed (300 dispatchers):** 100% of alerts within 60 s (typical 2.7 s, p99 9.3 s);
  0 bans and 0 rate-limit responses in 33 million board requests; duplicates 0.03%. Completeness was 96–97%, below
  the 99% target; two causes found and fixed on 2026-11-06 ([SLO.md](SLO.md)).
- **Capacity:** one engine thread serves ~2,000 dispatchers within every SLO; the speed SLO breaks between 2,000 and
  5,000. Split into 2 engine workers, the same load got 1.77× the board requests (3,745 → 6,617/s) ([SLO.md](SLO.md)).
- **Push feed behind nginx:** 1 → 3 ingest workers (one core each) took 2,050 → 3,346 postings/s; hash routing kept
  duplicate alerts at 2%, round robin gave 43% ([SLO.md](SLO.md)).
- **Dedup classifier:** wrong merges 1,806 → 27 on held-out pairs; end to end, missed alerts 4.73% → 1.80% and
  duplicates 2.74% → 0% ([ML.md](ML.md)).
- **Search parser:** 98% of test searches fully right with rules + GLiNER2 ([ml/parser/RESULTS.md](ml/parser/RESULTS.md)).
- **Load-decision agent:** a model doing the whole decision is right 21–42% of the time; the same models only reading
  the comments, with code deciding, are right 94–100% on messy wording vs 56% for keywords ([ML.md](ML.md) §3).

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

## Live mode (try it yourself)

Open **http://localhost:8080** (served by the server, through the tunnel). The `live` service never stops and makes a new world every time it starts:

- **New data all the time.** Loads arrive as they would on a real board ([sim/world.ts](sim/world.ts), the same calibrated model the batch generator uses), following the US Central day: busy 7–12, quiet overnight. Each load spreads into postings over its life: refreshes, reposts with new ids, copies on other boards, a co-broker. 300 synthetic dispatchers with ~1,100 saved searches poll the boards alongside you.
- **You are a dispatcher.** Type a search in plain English; the parser (rules + GLiNER2, every call traced in Langfuse) shows what it understood and asks when something is unclear. Save it, and alerts arrive the way the Telegram bot would send them.
- **Scored live.** The answer key is built as each load is born, so the page shows misses, duplicates and post-to-alert latency for everyone and for you, in real time.
- **Push it.** Speed slider (1–120×), freight volume (10K–100K loads/day), and burst buttons (500 loads out of one market at once) to watch queues, 429s and latency react; Grafana shows the same from the engine's metrics. Above ~30× one Node process can't keep up and the UI says so.
- **Removing a search cancels it.** Deleting a saved search also cancels its queued and held alerts (`engine.refreshSearches`), so you don't keep getting alerts for a search you just removed.

**Known issues:** "loads out of springfield tmrw" asks "Which Springfield?" twice (origin and destination); misses
aren't logged with a reason yet; there's no slow-burn completeness alert. The full list is in [GUIDE.md §11](GUIDE.md#11-honest-limits-and-whats-next).

Code: [live/](live/) (stream, live scorer, API) and [ui/](ui/) (React + shadcn/ui). UI development: `cd ui && npm run dev` (proxies `/api` to localhost:8080).

## Run it

Everything (live mode, models, observability, and the engine/simulators/eval on demand) runs in Docker Compose on one Linux server; see [DEPLOY.md](DEPLOY.md). On the server, from `~/load-radar`:

```bash
docker compose up -d                                         # live mode + models + observability, restart on reboot
alias app='docker compose run --rm --use-aliases app'        # Node 26 container on the same network
app node sim/gen.ts --loads 8000 --users 300 --hours 2 --out out-small
app node scripts/run.ts --data out-small --speed 30 --minutes 3 --otlp http://otel-collector:4318/v1/traces
```

The last line printed is `RUN_RESULT {...}`: alerts expected vs delivered, misses, duplicates, latency (simulated seconds), board stats (429s, bans) and engine counters. The same JSON is written to `out-small/run/result.json`. Prometheus scrapes the engine at `app:9464` while it runs.

From the Mac, the UIs open on localhost through the SSH tunnel (`ops/macos/com.loadradar.tunnel.plist`): live UI :8080, Grafana :3000 (traces in Tempo, logs in Loki, metrics in Prometheus, all linked), Langfuse :3001 (login: `LANGFUSE_INIT_USER_*` in `.env`), Prometheus :9090.

### Search parser and LLM observability

```bash
app node src/parse/cli.ts --mode hybrid --gliner http://gliner2:7100 --otlp http://otel-collector:4318/v1/traces "reefr out of fresno going anywhere"
app node ml/parser/eval.ts --gliner http://gliner2:7100 --ollama http://ollama:11434 \
  --otlp http://otel-collector:4318/v1/traces --langfuse http://langfuse-web:3000
```

Each model call then appears in Langfuse with the exact prompt, the raw output, tokens and latency, and eval runs attach a correctness score to each call. Qwen runs on the server's CPU: about 16 s per call (vs ~0.5 s on the Mac), so the Qwen contenders make a full eval take ~15 minutes. The rules + GLiNER2 hybrid stays at ~50 ms.

### History: the first end-to-end run (2026-11-04)

Small dataset (3,000 loads, 100 customers, 172 logins), 90 simulated minutes at 60× speed, scored against the answer key:

| | First run | After the fix |
| --- | --- | --- |
| Alerts delivered / expected | 753 / 2,353 | 2,268 / 2,353 |
| Missed | 68% | 3.6% |
| Post-to-alert p50 / p95 / p99 | 2 s / 438 s / 1,343 s | 3 s / 62 s / 277 s |
| Duplicate alerts | 0.7% | 2.2% |
| Board requests / 429s / bans | 495K / 0 / 0 | 495K / 0 / 0 |

**The bug the first run found:** each customer fetches the same posting with their own login. Dedup treated the second customer's copy as a refresh and stopped, so only the first customer to fetch a load was ever alerted. Matching now runs once per (customer, load).

**Open issues for Day 2:** duplicates (2.2%, target < 1%: dedup misses some cross-posts, which the classifier should fix); 258 alerts the scorer didn't expect (likely the scorer and engine reading slightly different values: board mileage, repost rates and dates); the p99 tail from quiet lanes polled every few minutes.
