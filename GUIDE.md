# Load Radar, from zero

This guide is for someone who knows nothing about trucking or this codebase. Read it top to bottom: each part builds
on the one before, and each ends with **Go deeper** links to the detailed documents. Stop wherever you have enough.

| Part | You'll know |
| --- | --- |
| [1. The problem](#1-the-problem) | What dispatchers do and why they need this |
| [2. What Load Radar does](#2-what-load-radar-does) | The product, and the measured results |
| [3. How one load becomes an alert](#3-how-one-load-becomes-an-alert) | The pipeline, step by step |
| [4. How we test without real load boards](#4-how-we-test-without-real-load-boards) | The simulated world and answer key |
| [5. Architecture](#5-architecture) | Live mode, the engine cluster, where state lives |
| [6. Technology and why](#6-technology-and-why) | The stack, briefly |
| [7. Machine learning](#7-machine-learning) | The three models and their results |
| [8. Reliability: SLOs and overload](#8-reliability-slos-and-overload) | What "working" means, and what happens under stress |
| [9. Scalability](#9-scalability) | Measured capacity, why it breaks, the path up |
| [10. Operations](#10-operations) | Deploy, access, observability |
| [11. Honest limits and what's next](#11-honest-limits-and-whats-next) | What isn't proven yet |
| [Glossary](#glossary) | Every term used here |

---

## 1. The problem

**Trucking in 30 seconds.** A *shipper* has goods to move. A *broker* takes the job and posts it as a **load** on a
**load board**, a marketplace website: "pick up in Chicago today, deliver to Atlanta, dry van, $1,950." DAT is the
biggest board (about 500,000 load posts a day), then Truckstop, then many smaller broker portals. A *carrier* owns
trucks. Its **dispatcher** keeps those trucks loaded.

**The pain.** When a truck goes empty, the dispatcher searches every board by hand and refreshes all day. Good loads
are taken within minutes, usually by whoever calls the broker first.

**The idea.** The dispatcher saves the search once. Software watches every board and alerts them the moment a
matching load appears.

**Why that's hard:**

1. **Each dispatcher's searches must run on their own board login.** One login is for one person, and different
   carriers are allowed to see different loads, so one check can't serve two customers.
2. **Boards limit each login** and **ban** accounts that check too often. A banned login is a customer who can't
   work — the worst thing the system can do.
3. **The same load appears many times:** refreshed, re-posted with a new id, copied to other boards, re-posted by a
   second broker at a lower rate. About half of all board rows are duplicates. The dispatcher wants **one** alert.
4. **One load can match thousands of saved searches,** and the alert channel delivers only about 30 messages a
   second per sender.

So the work is in **polling politely, recognizing duplicates and fanning out alerts**, not in the freight.

**Go deeper:** [DESIGN.md §1–2](DESIGN.md) (the problem and the constraints, with sources).

## 2. What Load Radar does

From the dispatcher's side:

1. **Type a search in plain English:** "reefer outta fresno, nothing under 3, 100 dh." The system shows what it
   understood and asks when something is unclear ("Which Springfield?"), instead of guessing.
2. **Get an alert within seconds** of a matching load on any board they have a login for — one alert per real load,
   however many times it's posted.
3. **Ask "Should I take it?"** A local AI model reads the broker's comments ("8FT TARPS", "-10F FROZEN"), and code
   applies the dispatch policy: book, negotiate (with a counter-offer), ask for the rate, or skip.

Under the hood it must never get a login banned, never silently miss a load, and stay fast as customers grow.

**Where it stands:** fully built and running continuously on one Linux laptop used as a server, against a simulated
world (Part 4). It has never been connected to real boards.

| | Result |
| --- | --- |
| Alert speed | 100% of alerts within 60 s; typical 2.7 s, p99 9.3 s (30 h live, ~290,000 alerts) |
| Account safety | 0 bans, 0 rate-limit responses in 33 million board requests |
| Duplicates | 0.03% of alerts |
| Capacity | The engine cluster serves ~15,000 dispatchers within target on one 4-core server (4 engines) |
| Dedup classifier | 99.85% precision, 99.4% recall |
| Search parser | 98% of test searches fully right |
| Load-decision agent | 88–100% right splitting the job, vs 21–42% letting a model decide everything |

## 3. How one load becomes an alert

```
 Search ─▶ Parser ─▶ Planner (which board queries, how often)
                        │
 Load boards ◀── Scheduler + pollers (never exceed a login's limit)
      │
      ▼
 Normalizer ─▶ Dedup ─▶ Matcher ─▶ Alert queue ─▶ Notifier ─▶ Dispatcher
```

Creating a search is the *cold path* (rare, so accuracy matters more than speed). Everything from the scheduler on
is the *hot path*: it runs for every posting, so it must be fast and cheap.

- **Parser.** Rules first (prices, equipment words, a ~15,000-town gazetteer), ~0.1 ms. **GLiNER2** only when
  rules miss the equipment or origin — it can only point at words already in the sentence. Anything still
  unclear becomes a question.
- **Planner.** Merges one customer's overlapping searches into fewer board queries; sets each query's check
  frequency by the **square-root rule** (frequency ∝ √how busy the lane is), under a fixed budget.
- **Scheduler + pollers.** A min-heap by next-check-time, one entry per (login, query). Token-bucket budget per
  login, **at most one request in flight per login**, duplicate polls coalesced, backoff on 429 honoring
  `Retry-After`, circuit breaker before a ban.
- **Normalizer.** One adapter per board turns its format (`"V"` vs `"VAN"`, missing rates, truncated city names)
  into one `Load` record with coordinates and **who may see it**.
- **Dedup.** Exact match on board id (free), then a trained **classifier** for new ids against candidates sharing
  date, area and equipment. Merging two different loads hides one from everyone, so the threshold favors
  precision (Part 7).
- **Matcher.** Searches are indexed by **geohash** cell, so finding candidates is a hash lookup. Exact filters
  then check distance, rate and **entitlement** (a load found via customer A's login may only alert A).
- **Alert queue + notifier.** One alert per (user, load); oldest first, freshest first when behind, alerts older
  than 10 minutes dropped. Respects the alert channel's limits (~30 msg/s per sender) and digests pending alerts.

**Go deeper:** [DESIGN.md §3](DESIGN.md) (architecture diagram), [LLD.md §4–6](LLD.md) (every component's types,
algorithms and edge cases).

## 4. How we test without real load boards

Real boards forbid scraping and cost money, and you can't know what you *missed*. So the project simulates the
market and keeps an **answer key** that knows the truth: 300 synthetic dispatchers with ~1,100 saved searches,
loads born on a realistic daily rhythm calibrated to DAT market data (`sim/world.ts`), each spreading into
refreshes, reposts, cross-posts and co-broker copies; four simulated boards with per-login budgets, 429s and bans
(`sims/boards-sim.ts`); and a simulated alert channel (`sims/telegram-sim.ts`) with per-sender and per-dispatcher
limits. When a load is born, the world already knows who *should* hear about it, so every delivered alert can be
scored: on time, late, duplicate, unexpected, or missed.

Two ways to run it: **batch** (a fixed dataset, up to 120× speed: `scripts/run.ts`) and **live** (an endless world
with a UI: `live/`).

**Go deeper:** [sim/ASSUMPTIONS.md](sim/ASSUMPTIONS.md), [LLD.md §5.2, §15](LLD.md).

## 5. Architecture

**Live** (the default) runs everything in Part 3 in one Node.js process, on one engine:

```
 WORLD THREAD    endless loads & postings, boards-sim, alert channel, the answer key — its own CPU core
       ▲ HTTP, exactly as to real boards
 MAIN THREAD     the engine (scheduler → pollers → normalize → dedup → match → alerts) + HTTP API + SSE for the UI
```

**The engine cluster** (run on demand, `scripts/cluster-steps.sh`) scales the engine out to several containers:

```
                 ┌─ engine 1 ─┐
 dispatchers ─▶ nginx ─ engine 2 ─▶ boards (world)
                 └─ engine 3 ─┘
```

Each engine container starts empty and **owns** whichever dispatchers' requests reach it: it polls the boards for
just those dispatchers (their logins, rate limits, "already alerted" memory, alerts). nginx picks the engine for
each request with a **consistent hash on the dispatcher id**, so one dispatcher's calls always land on the same
engine. Round robin instead (rejected) would send a dispatcher's calls to engines that don't own it: measured 48%
duplicate alerts and 54% misrouted calls, against 0% for both with hash routing.

**State** lives in memory inside the engine, no database on the hot path, so a restart loses it; saved searches
persist as JSON on a volume. Every piece of state already has a **partition key** (login, map cell or user), so
splitting it across engines is routing, not a redesign.

**Runs on** one Linux laptop (4 cores, 14 GB RAM) via Docker Compose: `live` (engine + world + API + UI),
`gliner2`, `ollama`, the engine cluster (on demand, live stopped meanwhile), and observability (OTel Collector,
Prometheus, Tempo, Loki, Grafana, Langfuse).

**Go deeper:** [DESIGN.md §3.0](DESIGN.md) (full live diagram), [LLD.md §1–4](LLD.md) (processes, data types,
state, stages and queues), [LLD.md §16](LLD.md) (full repo layout).

## 6. Technology and why

TypeScript/Node.js for the engine, simulators and API — one language, fast enough per posting. React + shadcn/ui
with server-sent events for the UI. A scikit-learn logistic regression for dedup, scored in TypeScript (~130
ns/pair, no Python in the engine). GLiNER2 for parsing spans (~50 ms, can't invent places). Qwen 2.5 3B via Ollama
for the agent, local and free. Prometheus + OpenTelemetry → Tempo/Loki for metrics, traces and logs, one Grafana
UI linked by `trace_id`. Langfuse for every model call. Docker Compose with a cron pulling `main` for deploy — no
inbound connections, no CI runner on a public repo. Lite metrics and 1% trace sampling cost +1.0% CPU; the
default OpenTelemetry setup cost far more (+18–41%).

**Go deeper:** [DESIGN.md §4](DESIGN.md) (all 30 decisions, each with the alternative and trade-off),
[bench/overhead/RESULTS.md](bench/overhead/RESULTS.md).

## 7. Machine learning

The rule across all three models: **cheap deterministic code first, a model only where code can't decide, and
every model measured against an answer key.**

**Dedup classifier.** The answer key labels every candidate pair for free: 305,609 training pairs, evaluated on an
unseen world. 18 features (`src/dedup/features.ts`, shared by training and serving) — weight and comment
similarity matter most. Logistic regression at a threshold for ≥99.5% precision: **99.85% precision, 99.4%
recall** (27 wrong merges, 101 missed, on 61,122 held-out pairs) — ahead of a hand-written rule (90.0% / 92.7%),
about even with LightGBM (not used; costlier to serve). End to end: missed alerts 1.80%, duplicates 0.00%. Honest
limit: the simulator copies weight and comments exactly between postings, easier than real boards.

**Search parser.** Rules + GLiNER2: **98%** of 40 labeled searches fully right, vs rules alone 95%, GLiNER2 alone
60%, a chat model 80% (0.5–15 s/call).

**Load-decision agent.** Splitting the job (model reads the comments, code applies the policy) reached 88–100%,
including 100% on messy real-world phrasing vs 56% for keyword rules. A model deciding everything was right only
21–42%. Live: Qwen 2.5 3B, ~3 s on CPU.

**Go deeper:** [ML.md](ML.md) (everything, with a changelog), [ml/dedup/RESULTS.md](ml/dedup/RESULTS.md),
[ml/parser/RESULTS.md](ml/parser/RESULTS.md), [ml/agent/RESULTS.md](ml/agent/RESULTS.md).

## 8. Reliability: SLOs and overload

Three **service level objectives**:

| SLO | Target |
| --- | --- |
| Alerts are fast | 99% within 60 s of the load appearing |
| Alerts are complete | 99% of matching loads that stay 5+ min get an alert |
| Boards stay friendly | 0 banned logins, under 1% of requests answered 429 |

Each has an **error budget** (the 1% allowed to fail, per rolling hour) and a **burn-rate alert** that pages when
it's being spent 10× too fast, confirmed over two windows.

**Overload rules:** at most one request in flight per login, duplicate polls coalesced, backoff on 429 honoring
`Retry-After`, a circuit breaker before a ban, freshest-first delivery once behind, alerts older than 10 minutes
dropped. Measured at 30× real speed: 83.7% of alerts within 60 s (p50 29 s), completeness 87.9%, 0 429s, 0 bans —
speed and account safety come first, so completeness is what gives.

At real speed, with no overload, completeness runs 96–97%, below the 99% target — the main known gap (Part 11).

**Go deeper:** [SLO.md](SLO.md) (targets, budgets, every measurement), [OBSERVABILITY.md](OBSERVABILITY.md)
(metrics catalog, sampling, dashboards, runbooks), [LLD.md §8](LLD.md) (guarantees and backpressure).

## 9. Scalability

**What drives load is board requests, not freight:** ~1 request/s per dispatcher (dispatchers × logins), each
login fetching its own copy of the board.

Measured with the engine cluster on one 4-core server (100K loads/day ≈ 60% of DAT):

| Engines | Dispatchers | Alerts ≤ 60 s | Board requests/s | Whole machine CPU |
| --- | --- | --- | --- | --- |
| 1 | 6,000 | 100% | 6,050 | 2.0 of 8 threads |
| 3 | 12,000 | 100% | 12,096 | 4.0 |
| **4** | **15,000** | **100%** | **15,096** | **5.0** |
| 5 | 18,000 | 98.7% (edge) | 17,972 | 6.7 |

Each engine is one core and serves ~3,800 board requests/s within target; past ~18,000/s all 8 hardware threads of
this 4-core server are busy.

**The path up:**

| Step | Status | Rough capacity |
| --- | --- | --- |
| **Engine cluster** (engines behind nginx, one machine) | Built, measured | 4 engines: ~15,000 board requests/s, 15,000 dispatchers within the SLO |
| Engines on several machines; handover and crash recovery | Not built | — |

No step puts a database on the hot path. [LLD.md §12](LLD.md) lists the measured triggers for adding a shared
store.

**Go deeper:** [SLO.md](SLO.md) (scale steps), [DESIGN.md §5](DESIGN.md) (what breaks first at 1000×, ranked),
[LLD.md §9, §11–12](LLD.md) (pools and N+1, single-machine capacity, when to add a store).

## 10. Operations

Deploy is `git push` to `main`: a cron pulls every minute and restarts the live world
(`ops/server/deploy.sh`) — never push during a measurement. Access is over Tailscale and SSH, tunneled to the
Mac: live UI :8080, Grafana :3000, Langfuse :3001, Prometheus :9090. One Grafana dashboard covers SLOs, requests,
dedup decisions, alerts, latency, queues, bans, model calls, traces and logs. Everything runs on one box; nothing
yet checks it's reachable from outside (Part 11).

**Go deeper:** [DEPLOY.md](DEPLOY.md) (setup from scratch), [OBSERVABILITY.md §10–12](OBSERVABILITY.md)
(dashboards, alerts, runbooks).

## 11. Honest limits and what's next

**Not proven:**
- **No real boards, data or users.** Board access needs paid accounts; real pages, limits and anti-bot rules would
  be the first thing to break. Every accuracy number comes from our own world, so it is optimistic.
- **Small eval sets** (16, 24, 40 cases); one case is 2.5–6 points. Some prompts and rules were tuned on those
  cases.
- **Capacity beyond one machine** is designed and estimated, not measured.
- **Restarts lose in-memory state** (no snapshots yet).
- **Completeness at real speed is 96–97%,** below the 99% target.

**Next, in order:**
1. Log every miss with a reason (failed to parse, merged by dedup, never polled, outside the area).
2. A slow-burn completeness alert, and a health check from outside the server.
3. Shard the engine across machines and measure the new knee.
4. Shadow-mode plan for the dedup classifier on real data; idempotency key on `POST /api/searches`; the
   "Which Springfield?" double question.

## Glossary

| Term | Meaning |
| --- | --- |
| **Load / posting** | A load is one real shipment. A posting is one appearance of it on one board; one load has many postings |
| **Load board** | A marketplace website where brokers post loads (DAT, Truckstop, broker portals) |
| **Dispatcher** | The person at a carrier who finds loads for its trucks |
| **Lane** | An origin → destination route plus equipment, e.g. "Chicago → Atlanta, van" |
| **Equipment** | Trailer type: van (dry box), reefer (refrigerated), flatbed |
| **Deadhead** | Empty miles driven to reach the pickup |
| **Rate / RPM** | What the load pays; rate per mile |
| **Co-broker** | A second broker re-posting someone else's load at a lower rate |
| **Hot path / cold path** | Code that runs for every posting (must be fast) vs code that runs rarely (can be slow) |
| **Latency, p50 / p95 / p99** | How long something takes; the time that 50% / 95% / 99% of cases beat |
| **Post-to-alert** | The key latency: from a load's first posting on a board the dispatcher can see, to the alert arriving |
| **Throughput** | How much work per second (here: board requests per second) |
| **429** | HTTP "Too Many Requests": the board telling us to slow down |
| **Token bucket** | A rate limiter: requests spend tokens that refill at a fixed rate |
| **Backoff / circuit breaker** | Waiting longer after each failure / stopping a login entirely before it's banned |
| **Event loop / event-loop lag** | Node's single thread that runs all JavaScript / how late it is getting to queued work. The engine's bottleneck signal |
| **Geohash** | A way of naming map cells (`dp3` ≈ Chicago area) so "what's near here" is a lookup |
| **Entitlement** | Who may see a load: one found with customer A's login may only alert A |
| **Dedup** | Recognizing that two postings are the same real load |
| **Precision / recall** | Of the merges made, how many were right / of the merges that should happen, how many were made |
| **Gazetteer** | The town list used to turn names into coordinates |
| **Answer key** | The simulator's record of the truth: every load, its postings, and who should be alerted |
| **SLO / SLI** | A target we promise / the measurement it's judged by |
| **Error budget / burn rate** | The share allowed to fail / how fast that allowance is being used (1 = exactly on budget) |
| **Sharding / partition key** | Splitting work so each worker owns a slice, by a key like login id or map cell |
| **N+1** | One call for a list, then one more call per item: fine with 10 items, terrible with 5,000 |
| **Observability: metrics, traces, logs** | Numbers over time / one item's path through every step / one line per event |
| **Span / sampling** | One timed step in a trace / recording only some traces to save cost |
| **Shadow mode** | Running a new model alongside the old one, logging its decisions without acting on them |
