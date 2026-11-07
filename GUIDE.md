# Load Radar, from zero

This guide is for someone who knows nothing about trucking or this codebase. Read it top to bottom: each part builds
on the one before, and each ends with **Go deeper** links to the detailed documents. Stop wherever you have enough.

| Part | You'll know | Time |
| --- | --- | --- |
| [1. The problem](#1-the-problem) | What dispatchers do and why they need this | 3 min |
| [2. What Load Radar does](#2-what-load-radar-does) | The product from the user's side | 2 min |
| [3. How one load becomes an alert](#3-how-one-load-becomes-an-alert) | Every step of the pipeline, in order | 10 min |
| [4. How we test without real load boards](#4-how-we-test-without-real-load-boards) | The simulated world and the answer key | 5 min |
| [5. Architecture](#5-architecture) | Processes, threads, where state lives, what runs where | 10 min |
| [6. Technology and why](#6-technology-and-why) | Every tool in the stack and what it replaced | 5 min |
| [7. Machine learning](#7-machine-learning) | The three models, how they were built and measured | 10 min |
| [8. Reliability: SLOs and overload](#8-reliability-slos-and-overload) | What "working" means in numbers, and what happens under stress | 8 min |
| [9. Scalability](#9-scalability) | Measured capacity, why it breaks, the path to 1000× | 10 min |
| [10. Operations](#10-operations) | Deploy, server, observability, and the outage we learned from | 5 min |
| [11. Honest limits and what's next](#11-honest-limits-and-whats-next) | What isn't proven yet | 3 min |
| [Glossary](#glossary) | Every term used here | reference |

---

## 1. The problem

**Trucking in 30 seconds.** A *shipper* has goods to move. A *broker* takes the job and posts it as a **load** on a
**load board**, a marketplace website: "pick up in Chicago today, deliver to Atlanta, dry van, $1,950." DAT is the
biggest board (about 500,000 load posts a day), then Truckstop, then many smaller broker portals. A *carrier* owns
trucks. Its **dispatcher** keeps those trucks loaded.

**The pain.** When a truck goes empty, the dispatcher searches every board ("van, within 100 miles of Chicago, at
least $2.80 a mile") and refreshes all day. Good loads are taken within minutes, and usually by whoever calls the
broker first.

**The product idea.** The dispatcher saves the search once. Software watches every board and sends an alert to their
phone the moment a matching load appears.

**Why that's hard.** The freight itself is small: a few new loads per second across the US. What's big is *checking*
for it:

1. **Each dispatcher's searches must run on their own board login.** Board rules say one login is for one person,
   and different carriers are allowed to see different loads. So one check can't serve two customers.
2. **Boards limit each login.** Check too often and the board answers "429 Too Many Requests"; keep going and it
   **bans the account**. A banned login is a customer who can't work. That's the worst thing the system can do.
3. **The same load appears many times:** refreshed, re-posted with a new id, copied to other boards, re-posted by a
   second broker at a lower rate. About half of all board rows are duplicates. The dispatcher wants **one** alert.
4. **One load can match thousands of saved searches,** and Telegram allows only about 30 messages a second per bot.

So the work is in **polling politely, recognizing duplicates and fanning out alerts**, not in the freight.

**Go deeper:** [DESIGN.md §1–2](DESIGN.md) (the problem and the constraints, with sources).

## 2. What Load Radar does

From the dispatcher's side:

1. **Type a search in plain English:** "reefer outta fresno, nothing under 3, 100 dh". The system shows what it
   understood (reefer, origin Fresno CA, minimum $3.00/mile, 100 miles of deadhead) and asks when something is
   unclear ("Which Springfield?") instead of guessing.
2. **Get an alert within seconds** of a matching load being posted on any board they have a login for. One alert per
   real load, however many times it's posted.
3. **Ask "Should I take it?"** on an alert. A local AI model reads the broker's comments ("8FT TARPS", "-10F FROZEN"),
   and code applies the dispatch policy: book, negotiate (with a counter-offer), ask for the rate, or skip.

Under the hood it has to never get a login banned, never silently miss a load, and stay fast as customers grow.

**Where it stands:** fully built and running continuously on one Linux laptop used as a server, against a simulated
world (Part 4). It has never been connected to real boards. Measured:

| | Result |
| --- | --- |
| Alert speed | 100% of alerts within 60 s; typical 2.7 s, p99 9.3 s (30 h live, ~290,000 alerts) |
| Account safety | 0 bans, 0 rate-limit responses in 33 million board requests |
| Duplicates | 0.03% of alerts |
| Capacity, one engine thread | ~2,000 dispatchers within every target; breaks between 2,000 and 5,000 |
| Dedup classifier | wrong merges 1,806 → 27 vs the hand rule; end to end, misses 4.73% → 1.80%, duplicates 2.74% → 0% |
| Search parser | 98% of test searches fully right |
| Load-decision agent | 100% on messy real-world comment wording, vs 56% for keyword rules |

## 3. How one load becomes an alert

Here is the whole pipeline. Everything right of the scheduler runs for **every** posting (the *hot path*: must be
fast and cheap). Creating a search is the *cold path*: rare, so accuracy matters more than speed.

```
 Dispatcher types a search ─▶ Search parser ─▶ Planner: which board queries, how often
                                                  │
 Load boards ◀── Scheduler + pollers (never exceed a login's limit)
      │
      ▼
 Normalizer ──▶ Dedup ──▶ Matcher ──▶ Alert queue ──▶ Notifier ──▶ Dispatcher's phone
 (4 formats     (seen this   (which searches   (order under    (Telegram's
  → 1 format)    load before?) want this load?)  overload)       rate limits)
```

Each step, what it does and why it's built that way:

### 3.1 Search parser (cold path)
Turns a typed sentence into exact fields. **Rules first** (patterns for `$3.40`, `DH 100`, equipment words, a
gazetteer of ~15,000 US towns), about 0.1 ms. Only when the rules miss the equipment or the origin does it call
**GLiNER2**, a small AI model that points at words in the sentence ("this span is the origin"). It can only point at
words that are there, so it can't invent a city. Anything still unclear becomes a question. *Why not an LLM for
everything?* Measured: a chat model alone was right 80% of the time and took 0.5–15 s; rules + GLiNER2 is right 98%.

### 3.2 Planner
When searches change, it rebuilds each login's **poll plan**. It merges one customer's overlapping searches into fewer
board queries, and gives each query a check frequency by the **square-root rule**: frequency ∝ √(how busy that lane
is). Busy lanes get checked every few seconds, quiet ones every few minutes, and a fixed budget gives the lowest
average discovery delay. (`src/plan/planner.ts`)

### 3.3 Scheduler and pollers
A min-heap ordered by "next check time", one entry per (login, query). It enforces each login's budget (a token
bucket), backs off on a 429 and honors `Retry-After`, pauses a login before it can be banned (circuit breaker), and
keeps **at most one request in flight per login**. That last rule came from a real failure (Part 8). Pollers make the
HTTP requests through per-board connection pools, and each request asks only for "what's new since my cursor".

### 3.4 Normalizer
Every board formats loads differently: `"V"` vs `"VAN"` vs `"Dry Van 53'"`; `"$0"` or `null` for no rate; weight
"12.00 lbs" meaning 12,000; city names cut to 14 characters on Truckstop. One adapter per board turns all of them into
one `Load` record with coordinates (from the gazetteer) and **who may see it** (the login that found it).

### 3.5 Dedup
Two stages. **Exact:** the same board id was seen before → it's a refresh. Free. **Same-load classifier:** for a new
id, find candidates that share pickup date, origin area, destination area and equipment, posted within 6 hours
(typically 0–10), and ask a trained model "same real load?" Mistakes are asymmetric: **merging two different loads
hides one from every dispatcher**, while missing a merge only sends one duplicate. So the threshold is set for 99.5%
precision. (Part 7.)

### 3.6 Matcher
Which saved searches want this load? The map is cut into **geohash** cells (level 3, about 117 × 157 km). Each search
is listed under every cell its deadhead circle touches (6–20 cells). A load is a point, so finding candidate searches
is one hash lookup, not a scan. Exact filters then check distance, destination, rate floor, and **entitlement**: a
load found with customer A's login may only alert customer A.

### 3.7 Alert queue and notifier
One alert per (user, load), even if two searches match. Normally oldest first, which keeps the worst wait short. When
delivery falls behind, **freshest first**, since old loads are probably taken; alerts older than 10 minutes are
dropped and counted. The notifier respects Telegram's limits (~30 messages/s per bot, ~1/s per chat) and merges
several pending alerts for one chat into a digest.

### 3.8 One posting's journey
> 9:02:10. A broker posts a Chicago → Atlanta van load, $1,950, on DAT.
> 9:02:14. The scheduler fires customer #318's "vans around Chicago" query (a busy lane, checked every ~5 s).
> The normalizer turns `"CHICAGO HEIGHTS, IL"`, `"V"`, `1950` into a `Load`. Dedup: new id, no earlier posting.
> Matcher: 3 candidate searches, 2 pass the filters. Queue: one alert for #318.
> 9:02:16. Sent. **Post-to-alert: 6 seconds.**
> 9:03:40. The same load is cross-posted on Truckstop at $1,975. The classifier says "same load". No second alert.

**Go deeper:** [DESIGN.md §3](DESIGN.md) (architecture diagram), [LLD.md §4–6](LLD.md) (every component's types,
algorithms and edge cases).

## 4. How we test without real load boards

Real boards can't be used: their terms forbid scraping, accounts cost money, and you can't know what you *missed*.
So the project builds a **simulated world** that behaves like the real market, and an **answer key** that knows the
truth.

- **The world** (`sim/world.ts`): loads are born following the US Central-time day (busy 7–12, quiet overnight), with
  equipment mix, rates and trip lengths calibrated to DAT market data and a public board sample. Each load spreads
  into postings over its life: refreshes every ~30 min, reposts with new ids, copies on other boards ~90 s later, a
  co-broker at 5–12% lower rate ~10 min later. 30% have no rate. `sim/validate.ts` checks 16 statistics against
  their sources; every number is listed with its source in [sim/ASSUMPTIONS.md](sim/ASSUMPTIONS.md).
- **Four simulated boards** (`sims/boards-sim.ts`) with four different formats, per-login request budgets, 429s with
  `Retry-After`, bans after repeated abuse, and loads that disappear when taken (~20 min after posting).
- **A simulated Telegram** (`sims/telegram-sim.ts`) with the real rate limits.
- **300 synthetic dispatchers** with ~1,100 saved searches and their own board logins, plus you in the UI.
- **The answer key.** When a load is born, the world already knows who *should* hear about it: every search that
  matches it, on a board that user has a login for. Every delivered alert is checked against that: on time, late,
  duplicate, unexpected, or missed. This is something a production system can only estimate, and it's what makes every
  number in this guide exact.

Two ways to run it: **batch** (generate a fixed dataset, run the engine for N minutes at up to 120× speed, score it:
`scripts/run.ts`) and **live** (an endless world, scored continuously, with a UI: `live/`).

**Go deeper:** [sim/ASSUMPTIONS.md](sim/ASSUMPTIONS.md), [LLD.md §5.2, §15](LLD.md) (simulator contracts, how
everything is verified without unit tests).

## 5. Architecture

### 5.1 The live service: one process, several threads

Everything in Part 3 runs in one Node.js process. The simulated world runs on a **separate thread with its own CPU
core**, so the engine never shares a core with the boards it polls. That was a measured problem in the first version.
The engine can also be split into **N worker threads** (`LIVE_ENGINE_WORKERS=N`), each owning a share of the
dispatchers; by default it runs on the main thread.

```
┌─ live container ──────────────────────────────────────────────────────────────────────────┐
│ WORLD THREAD (live/world-worker.ts)          "the outside world"                           │
│   sim/world.ts → live/stream.ts   endless loads and their postings, released on time       │
│     ├─ boards-sim   :7001   budgets, 429s, bans, loads taken after ~20 min                 │
│     ├─ telegram-sim :7002   30 msg/s per bot, 1 msg/s per chat                             │
│     └─ live/score.ts        the answer key, scoring every delivery                         │
│            ▲ HTTP, exactly as to real boards                                               │
│ ENGINE WORKERS (live/engine-worker.ts) ×N, each owning 1/N of the dispatchers              │
│   src/engine.ts   scheduler → pollers → normalize → dedup → match → alert queue → notifier │
│ MAIN THREAD (live/server.ts): HTTP API + SSE for the UI; /api/parse → GLiNER2;             │
│   /api/agent → Ollama; runs the engine itself when N = 0                                   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
      ▲ browser (React UI)                    │ telemetry (OpenTelemetry)
                                              ▼
  otel-collector ─┬─ traces → Tempo        ─┐
                  ├─ model calls → Langfuse ├─ Grafana dashboard (metrics, traces, logs linked)
                  └─ logs → Loki           ─┘
  Prometheus scrapes the engine and the answer key → SLOs, error budgets, burn-rate alerts
```

The engine code is the same in batch and live mode; it can't tell simulated boards from real ones, because it only
talks HTTP to them.

### 5.2 Where state lives

**In memory, inside the engine, with no database on the hot path.** Dedup's recent postings, the matcher index, the
schedule heap and the alert queue are plain in-memory structures connected by bounded queues. Why: no network call per
posting means no N+1 queries and no connection-pool waits (which usually bite long before a database does), and
single-threaded JavaScript makes every update atomic for free. The cost: a restart loses in-flight state. Saved
searches persist as JSON files on a Docker volume. Every piece of state already has a **partition key** (login, map
cell or user), so splitting it across workers later is routing, not a redesign.

### 5.3 What runs on the server

Docker Compose on one Linux laptop (4 cores, 14 GB RAM): `live` (engine + world + API + UI), `gliner2` (parser model),
`ollama` (local LLMs for the agent), and observability: OpenTelemetry Collector, Prometheus, Tempo, Loki, Grafana, and
self-hosted Langfuse (with its Postgres, ClickHouse, Redis and MinIO).

### 5.4 Repo map

```
src/        the engine: plan/ schedule/ poll/ normalize/ dedup/ match/ alerts/ parse/ agent/ obs/, engine.ts wires them
sim/        the world model and batch generator          sims/   simulated boards and Telegram
live/       always-on server, stream, live answer key    ui/     React + shadcn frontend
scorer/     batch answer-key scorer                       ml/     training, evals and results for every model
ops/        deploy script, Prometheus/Grafana/Tempo/collector config, Mac tunnel   bench/  observability cost test
```

**Go deeper:** [DESIGN.md §3.0](DESIGN.md) (full live diagram), [LLD.md §1–4](LLD.md) (processes, data types, state,
stages and queues), [LLD.md §16](LLD.md) (full repo layout).

## 6. Technology and why

| Piece | Technology | Why this one | What we gave up |
| --- | --- | --- | --- |
| Engine, simulators, API | **TypeScript on Node.js** | One language for engine, simulators and UI; measured fast enough per posting | One JS thread per process, so it needs worker processes sooner than Go or Rust would |
| UI | **React + shadcn/ui**, server-sent events | Data flows server → browser; SSE is plain HTTP and reconnects by itself | No resume after reconnect yet |
| Dedup model | **scikit-learn** logistic regression, scored in TypeScript | 18 multiply-adds (~130 ns/pair), no Python in the engine | A little recall vs LightGBM |
| Parser model | **GLiNER2** (`fastino/gliner2-base-v1`), CPU | Extracts spans, can't invent places, ~50 ms | Needs its own container |
| Agent model | **Qwen 2.5 3B** via **Ollama**, local CPU | Free, private, no API keys | Slow (~3 s), weaker than hosted models |
| Metrics | **Prometheus** + lite in-process metrics | Standard; recording rules turn metrics into SLOs | — |
| Traces / logs | **OpenTelemetry → Tempo / Loki** | One Grafana UI with logs, traces and metrics linked by `trace_id` | Two more services to run |
| Model calls | **Langfuse** (self-hosted) | Every prompt, output, token count and eval score per call | A heavy stack (Postgres, ClickHouse, Redis, MinIO) |
| Deploy | **Docker Compose** + a cron that pulls `main` every minute | Server accepts no inbound connections; no CI runner executing PR code on a public repo | Up to a minute of lag; rollback = `git revert` |

One measured decision worth knowing: the default OpenTelemetry tracing setup cost **+18% CPU** at 1% sampling and
**+41%** at 100% (losing 3% of spans). The engine uses lite metrics, its own 1% sampling and one span per posting:
**+1.0%**.

**Go deeper:** [DESIGN.md §4](DESIGN.md) (all 30 decisions, each with the alternative and trade-off),
[bench/overhead/RESULTS.md](bench/overhead/RESULTS.md) (the observability-cost benchmark).

## 7. Machine learning

The rule across all three models: **cheap deterministic code first, a model only where code can't decide, and every
model measured against an answer key.**

### 7.1 Same-load classifier (dedup), trained here
- **Labels for free:** the simulator's answer key says which postings belong to which load, so every candidate pair
  is labeled automatically. 305,609 pairs from a 30,000-load world (seed 11); evaluation on a world it never saw
  (seed 1).
- **18 features** computed by one function (`src/dedup/features.ts`) used for both training and serving, so the two
  can't drift: rate difference, same broker, time apart, town-name similarity, distance, weight difference, comment
  similarity, plus three interaction terms. Weight and comment similarity matter most: a real load keeps both on
  every board, while two different loads on the same lane rarely share them.
- **Model:** logistic regression (a weighted sum squashed to a probability, then a cutoff). Trains in 0.06 s.
  Split by time (train on the past, test on the future), with the threshold chosen for ≥ 99.5% precision.
- **Serving:** the weights ship in `ml/dedup/model.json`; the engine recomputes Python's probabilities for 20 sample
  pairs at startup and refuses the model if any differs by more than 1e-9.
- **Result:** wrong merges 1,806 → 27 on 61,000 held-out pairs; end to end, missed alerts 4.73% → 1.80% and
  duplicates 2.74% → 0%.
- **Honest limit:** the simulator copies weight and comments exactly between postings, so the two strongest features
  are easier here than on real boards. On real data: run it in shadow mode first.

### 7.2 Search parser: rules + GLiNER2 (pretrained, evaluated)
Five contenders on 40 labeled searches: rules alone 95%, GLiNER2 alone 60%, **rules + GLiNER2 98%** (live), a Qwen
chat model 80% at 0.5–15 s per call.

### 7.3 Load-decision agent (pretrained, evaluated)
Four designs on the same cases. Letting a model do the whole decision (with or without tool calls) was right 21–42%
of the time, and a 7B model was no better than 1.5B: it made policy and arithmetic errors. **Splitting the job**
(model reads the free-text comments into three fields, code applies the written policy) reached 88–100%, and 100% on
16 messy real-world phrasings where keyword rules got 56%. Live: Qwen 2.5 3B, ~3 s on CPU.

**Go deeper:** [ML.md](ML.md) (everything, with a changelog), [ml/dedup/RESULTS.md](ml/dedup/RESULTS.md),
[ml/parser/RESULTS.md](ml/parser/RESULTS.md), [ml/agent/RESULTS.md](ml/agent/RESULTS.md).

## 8. Reliability: SLOs and overload

### 8.1 What "working" means, in numbers
Three **service level objectives**, chosen from what a dispatcher feels:

| SLO | Target | Why that number |
| --- | --- | --- |
| Alerts are fast | 99% within 60 s of the load appearing | A good load is taken in ~20 min and the first caller wins; a minute is still early |
| Alerts are complete | 99% of matching loads that stay on the board 5+ min get an alert | A load taken in 2 min may be gone before any poll; one that sat 5 min is our fault |
| Boards stay friendly | 0 banned logins, under 1% of requests answered 429 | A ban is a customer who can't work |

Each has an **error budget** (the 1% allowed to fail, over a rolling hour) and **burn-rate alerts**: page when the
budget is being spent 10× too fast, confirmed over two windows so one slow minute doesn't page anyone.

### 8.2 Overload: a real failure and its fix
Pushing the live world to 120× speed with 100K loads/day **banned 541 of 548 logins**. Cause: the scheduler fired each
login's next poll on a timer without waiting for the previous answer, so hundreds of requests per login were in flight
before the first 429 came back. Fix: at most one request in flight per login, duplicate polls merged (a poll asks
"what's new since my cursor", so a copy fetches nothing), and under alert backlog freshest first with stale alerts
dropped. Same 30× test afterwards: alerts within 60 s 48.8% → 83.7%, bans 0. The cost moved to completeness
(92.3% → 87.9%), which is the right place for it.

### 8.3 A slow leak the alerts didn't catch
A 30-hour review (2026-11-06) found completeness steady at **96–97%**, below target, with no overload at all. It never
paged, because the burn rate was ~3.5 and the only rule fires above 10. Two causes, both fixed:
- Truckstop's 14-character names ("FORT LAUDERDAL", "ONTARIO (INLAN") failed to resolve after normalizing changed
  their length: ~2,000 postings dropped in 30 h. Truckstop place failures went 1.38% → 0.01%.
- The scorer started the clock at a load's first posting on *any* board, so a dispatcher who could only see the
  co-broker copy (~10 min later, another board) was counted as missed. Corrected, eval p95 latency re-scores from
  120 s to 5.3 s on the same deliveries.

The lesson: fast-burn alerts catch outages; a constant small leak needs a slow-burn alert and per-miss reasons.

**Go deeper:** [SLO.md](SLO.md) (targets, budgets, every measurement), [OBSERVABILITY.md](OBSERVABILITY.md)
(metrics catalog, sampling, dashboards, runbooks), [LLD.md §8](LLD.md) (guarantees and backpressure).

## 9. Scalability

### 9.1 What drives load
Not freight: **board requests**. Each dispatcher has ~1.8 logins and each login polls up to about once a second, so
requests grow with dispatchers × logins, and every login fetches its own copy of the board. Measured: about 1 board
request per second per dispatcher.

### 9.2 Measured on one 4-core laptop (real speed, 100K loads/day ≈ 60% of DAT)

| Dispatchers | Alerts ≤ 60 s | Typical alert | Board requests/s | Engine CPU |
| --- | --- | --- | --- | --- |
| 300 | 100% | 2.7 s | 298 | 0.4 cores |
| 1,000 | 100% | 3.3 s | 954 | 1.0 |
| **2,000** | **100%** | **3.3 s** | **1,882** | **1.3** |
| 5,000 | 97.3% (missed) | 35 s | 3,318 | 2.0 |

**What breaks first is the engine's single JavaScript thread**, not the machine: at 5,000 dispatchers two cores were
still free. One engine thread handles about **2,000–3,000 board requests per second** within the targets. Nothing was
lost at the knee (completeness, 429s and bans held); alerts just got slower.

### 9.3 The path up (estimates, except where marked measured)

| Step | Change | Rough capacity |
| --- | --- | --- |
| Bigger single core | Same code on a modern server CPU (1.5–2× faster per core) | ~3,000–5,000 dispatchers |
| **Shard the engine** (built for one machine, measured) | N workers, each owning a share of the dispatchers; across machines, leases in Redis so a dead worker's logins move. Logins are independent, so this splits cleanly; each login's rate limiter stays local | Measured 1.77× with 2 workers on 4 cores (SLO.md); roughly linear in cores: 16 cores ≈ 35,000–45,000 |
| Many machines | Stateless workers on Kubernetes/Nomad, autoscaled on event-loop lag; many outbound IPs | ~2,500 req/s per worker → 500,000 req/s ≈ 200 workers ≈ 15 × 16-core machines |
| Partition the data | Postings into Kafka/Redpanda keyed by origin geohash; dedup and matching partitioned by the same key, so candidates are always local | Removes cross-shard lookups |
| Alerts | Own service, many bots, push/SMS as main channels (Telegram's ~30 msg/s/bot caps delivery long before polling does) | — |
| **Fewer requests** | Poll each area once and fan out to every matching search (if board terms allow), adaptive intervals; **partner/shared feeds** instead of per-login polling | Plausibly 5–10× fewer requests; the biggest lever at 1000×, and a business fix more than a technical one |

At no step does a central database sit on the hot path. [LLD.md §12](LLD.md) lists the measured triggers for adding a
shared store or a log.

**Go deeper:** [SLO.md](SLO.md) (scale steps), [DESIGN.md §5](DESIGN.md) (what breaks first at 1000×, ranked),
[LLD.md §9, §11–12](LLD.md) (pools and N+1, single-machine capacity, when to add a store).

## 10. Operations

- **Deploy = `git push` to `main`.** A cron on the server pulls every minute, rebuilds what changed and restarts it
  (`ops/server/deploy.sh`). Every push restarts the live world, so never push during a measurement.
- **Access** is over Tailscale (private network) and SSH; the Mac keeps an SSH tunnel up (launchd) so the UIs open on
  localhost: live UI :8080, Grafana :3000, Langfuse :3001, Prometheus :9090.
- **One Grafana dashboard** ("Load Radar"), provisioned from git: SLOs and budgets on top, then requests/s by
  status, postings, dedup decisions, alerts, latency, queues, bans, model calls, recent traces and logs.
- **The outage we learned from (2026-11-05):** the server's Tailscale key expired. The server kept running, but nobody
  could reach it for ~1.5 days, and nothing said so, because every alert runs on the same box. Fixes: disable key
  expiry for the server, and add a health check from outside it.

**Go deeper:** [DEPLOY.md](DEPLOY.md) (setup from scratch), [OBSERVABILITY.md §10–12](OBSERVABILITY.md)
(dashboards, alerts, runbooks).

## 11. Honest limits and what's next

**Not proven:**
- **No real boards, data or users.** Board access needs paid accounts; real pages, limits and anti-bot rules would be
  the first thing to break. Every accuracy number comes from our own world, so it is optimistic.
- **Small eval sets** (24, 16, 40 cases); one case is 2.5–6 points. Some prompts and rules were tuned on those cases.
- **Capacity beyond one machine** is designed and estimated, not measured.
- **Restarts lose in-memory state** (no snapshots yet).

**Next, in order:**
1. Log every miss with a reason (failed to parse, merged by dedup, never polled, outside the area).
2. Slow-burn completeness alert, and a health check from outside the server.
3. Shard the engine across workers and measure the new knee.
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
| **Post-to-alert** | The key latency: from a load appearing on a board to the alert arriving |
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
