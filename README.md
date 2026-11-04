# Load Radar: start here

A plain-language guide to this project: what problem it solves, why it's built this way, what every term means, how it grows to 1000x, and what has been measured so far. The detailed documents are listed at the end.

---

## 1. The problem, in plain words

**Trucking in 30 seconds.** A *shipper* has goods to move. A *broker* takes the job and posts it as a **load** ("pick up in Chicago today, deliver to Atlanta, $1,950") on a **load board**, a marketplace website. DAT is the biggest, with about 500,000 load posts a day. A *carrier* owns trucks. Its **dispatcher** keeps those trucks busy by finding loads.

**The pain.** When a truck goes empty, the dispatcher searches the boards and refreshes them all day. Good loads are taken within minutes, so whoever sees one first wins.

**The product.** The dispatcher saves a search once ("van, near Chicago, at least $2.80 a mile"). Our system watches every board and **sends an alert to their phone the moment a matching load appears.** Numeo sells this as "Load Radar". This project is our version of it, designed to grow 1000x.

**Why it's hard.** Not because of the amount of freight: new loads arrive only a few per second. It's hard because:
1. **Each customer's searches must run on that customer's own board login.** DAT's rules say one login is for one person, so one check can't serve two customers. The number of checks grows with customers × searches × boards.
2. **Boards limit each login.** Check too often and the account is suspended. That's the worst thing that can happen to a customer.
3. **The same load shows up many times:** refreshed, reposted, posted on several boards, re-posted by a second broker.
4. **One load can match thousands of saved searches**, and Telegram only allows about 30 messages per second per bot.

## 2. Why we're building this

This is an interview project for Numeo, which builds AI agents for trucking. Their job post says what they value, and each one maps to a part of this project:

| They value | Shown here by |
| --- | --- |
| "What breaks first at 1000x?" answered with specifics | A design with a ranked list of breaking points, and load tests that measure them |
| Observability-obsessed | Metrics, tracing and dashboards designed up front, and their cost measured (it's now +1%) |
| Customer-obsessed | Everything is judged by what the dispatcher feels: speed, nothing missed, no duplicates, account safe |
| Architecture over code | Every decision below comes with the alternative and the trade-off |

### Focus

The project goes deep on two areas: **backend/infrastructure** (scaling, measurement, observability) and **AI/ML**, where the system genuinely needs it:
- **ML: same-load classifier** for dedup. The simple rule wrongly merged 12% of loads; the classifier is trained on the generator's answer key, and its effect on misses and duplicates is measured end to end.
- **Search parser: rules + a small model.** Rules handle dispatcher shorthand; a small local model (GLiNER2, or Qwen via Ollama) fills what the rules miss; one normalizer resolves places, regions and typos and asks instead of guessing. Five contenders compared on one eval set: [ml/parser/RESULTS.md](ml/parser/RESULTS.md).
- **LLM observability:** every model call is an OpenTelemetry GenAI span, routed to self-hosted **Langfuse** (prompt, output, tokens, latency, eval scores), Grafana (Tempo for the trace, Loki for the logs) and Prometheus. See OBSERVABILITY.md §8b.

No frontend: the user-facing side is shown through the simulators, the scorer and the dashboards.

## 3. The solution in one picture

```
 Dispatcher types a search ──▶ Search parser ──▶ Plan: which board queries to run, how often
                                                   │
 Load boards ◀── Scheduler + pollers (respect each login's limit)
      │
      ▼
 Normalizer ──▶ Dedup ──▶ Matcher ──▶ Alert queue ──▶ Notifier ──▶ Dispatcher's phone
 (4 formats     (same load  (which searches  (freshest      (Telegram
  → 1 format)    seen twice?) want this load?) first if busy)  limits)
```

- **Search parser:** turns "need reefer out of Fresno paying 3.40" into exact fields. Simple rules first; an AI model only for messy text; the user always confirms.
- **Scheduler and pollers:** decide when to check each board with each login, and never exceed that login's limit.
- **Normalizer:** every board formats loads differently ("V" vs "VAN" vs "Dry Van 53'"); this converts all of them to one format.
- **Dedup:** recognizes the same load posted several times, so the dispatcher gets one alert, not five.
- **Matcher:** finds which saved searches want this load, using map cells (see "Geohash" in section 4) to skip irrelevant searches quickly.
- **Alert queue and notifier:** send alerts within Telegram's limits, freshest first when busy.

The **hot path** (everything from the scheduler to the phone) runs for every load, so it must be fast and cheap. The **cold path** (creating a search) is rare, so accuracy matters more than speed.

## 4. Words you'll see, explained

| Term | Meaning |
| --- | --- |
| **CPU** | The processor. "CPU time" = how long the processor actually worked on something |
| **CPU µs per posting** | Microseconds (millionths of a second) of CPU work to process one posting. Our main efficiency number: lower is better |
| **Throughput** | How many postings per second the system handles |
| **Latency** | How long something takes. Our key one: **post-to-alert**, from "broker posted" to "alert on the phone" |
| **p95 / p99** | 95% (or 99%) of cases are faster than this. Shows the slow tail, not the average |
| **SLO** | A promise we measure against, e.g. "95% of alerts in under 20 seconds on busy lanes" |
| **Observability** | Being able to see what the system is doing from the outside: is it healthy, where is it slow, why did this alert arrive late |
| **Metrics** | Numbers over time: alerts per second, latency p95, queue length. Cheap, good for graphs and alarms |
| **Tracing** | Following **one** item through every step, with the time each step took. Answers "why was this specific alert late?" |
| **Span** | One timed step inside a trace, e.g. "dedup took 40 µs" |
| **Sampling** | Recording only some traces (e.g. 1 in 100), because recording all of them costs too much |
| **Overhead** | Extra cost something adds. "Observability overhead" = how much more CPU the system uses with metrics and tracing on than off |
| **Noise / noise floor** | How much a measurement varies when nothing changed. If noise is ±10%, a 5% effect can't be seen |
| **Pinning** | Locking a program to one CPU core so other programs and the OS don't disturb its measurements |
| **Hot path / cold path** | Code that runs for every load (must be fast) vs. code that runs rarely (can be slower) |
| **Entitlement** | Who may see a load. A load found with customer A's login may only alert customer A |
| **Geohash** | A way to cut the map into cells with short names (e.g. `dp3` ≈ Chicago area), so "what's near here" becomes a quick lookup |
| **Partition** | Splitting work by a key (login, map cell, user) so each worker owns its own slice and nothing is shared |
| **N+1** | A slow pattern: one call to get a list, then one more call **per item**. Fine with 10 items, terrible with 5,000 |
| **Connection pool** | A fixed set of network connections shared by many requests. Too small, and requests wait silently |
| **Backpressure** | When a step falls behind, the steps before it slow down instead of piling up work |
| **1000x** | The system handling a thousand times today's load |

## 5. Why it's built this way: decisions, alternatives, trade-offs

Every choice has a cost. These are the main ones; [DESIGN.md](DESIGN.md) section 4 has the full table.

| Decision | Why | Alternative we didn't pick | What we give up |
| --- | --- | --- | --- |
| Check boards **with each customer's own login**, within its limit | Board rules; customers see different loads | One shared fetch for everyone (a cache) | Many more requests; budgets become the main limit |
| **Two kinds of sources:** gated boards (per login) and shared feeds (fetched once) | Shared feeds are the only way to avoid per-login polling at 1000x | Polling only | Needs partnerships, a business task more than a technical one |
| **Smart check timing:** busy lanes more often, using a square-root rule | Puts the limited budget where new loads actually appear | Same interval for everything | More logic in the scheduler |
| **Two-stage dedup:** exact check, then a small trained model | Exact IDs catch refreshes; only a model catches reposts and cross-posts | Exact IDs only | Needs training data (the generator provides it) and can merge wrongly |
| **Map cells (geohash level 3)** to find searches near a load | One lookup instead of scanning; measured 6–20 cells per search | Database range query on latitude/longitude; smaller cells (474 per search) | Some false candidates, removed by an exact distance check |
| **State in memory, no Redis on the hot path** | No network call per load; no N+1; simpler | Redis in the middle of every step | A crash loses up to 5 s of state (snapshots limit it) |
| **AI model only when creating a search** | It's slow (~1 s) and costs money; checking each load needs microseconds | AI on every load | Messy searches need a confirmation step |
| **Alert order:** oldest first normally, freshest first when overloaded | Oldest-first keeps waits short; when overloaded, old loads are probably taken | Always first-in-first-out | Some old alerts are dropped on purpose |
| **Lite metrics + our own 1% tracing, 1 span per load** | Measured: +1% CPU instead of +18–41% | Default tracing setup | Per-step timings come from 1 in 16 loads; fewer traces kept |
| **Synthetic data** calibrated to real numbers | Can't scrape real boards (their rules); gives an answer key | Scraping real boards | Results are only as real as the simulator (assumptions are listed) |
| **TypeScript on Node** | Numeo's stack | Go or Rust (faster per core) | One thread per process; more processes needed sooner |

## 6. How it grows to 1000x

Rough stages. The load tests replace these guesses with measurements.

| Stage | Example size | What we run | What breaks next | What we do |
| --- | --- | --- | --- | --- |
| **Today** | ~5,000 customers, ~5,300 board checks/s | One engine process, state in memory | Board limits per login | Merge each customer's searches into fewer queries; check busy lanes more often |
| **10x** | ~50,000 customers | Same, plus worker threads | One CPU core (parsing board responses) | Worker threads, split by login |
| **100x** | ~500,000 customers | Several machines, each owning a slice (by login, map cell or user) | Telegram delivery; memory per machine | In-app push as the main channel; more bots; smaller in-memory records |
| **1000x** | ~5M customers, millions of checks/s | Many machines connected by a log (Kafka), each owning partitions | Board limits again, now for the business | **Shared and partner feeds** replace per-login polling wherever possible. The biggest lever |

**At no stage** does a central database sit on the hot path. We add one only when a measurement shows a need ([LLD.md](LLD.md) section 12).

## 7. What we measured and why

### 7.1 Is the fake data realistic?
`sim/validate.ts` checks the generated loads against real numbers: DAT's equipment mix and rates, trip lengths, and a public board sample (missing rates, pickup days, duplicates). 16 checks pass; 1 has no trustworthy source and is reported only. See [sim/ASSUMPTIONS.md](sim/ASSUMPTIONS.md).

### 7.2 Does observability cost too much?
**Why ask:** observability runs on every load. If it costs 30% more CPU, we'd need 30% more servers, or we'd switch it off and fly blind.

**How we measured:**
1. Built the CPU part of the engine (normalize → dedup → match → alert).
2. Replayed the same 150,000 postings at 5,000 per second in each mode: nothing, metrics, tracing 1%, tracing 100%, and our fixes.
3. Calculated **CPU µs per posting = total CPU time ÷ postings processed**, and **overhead = (mode ÷ nothing) − 1**.
   Example: nothing = 106.5 µs, default tracing at 1% = 124 µs → 124 ÷ 106.5 − 1 = **+17%**.
4. Ran each mode 5 times and took the median.
5. **The laptop was too noisy** (±10%), so the test moved to a Linux machine with the program pinned to one core: ±1.4%.

**What we found** (details: [bench/overhead/RESULTS.md](bench/overhead/RESULTS.md)):

| Setup | Extra CPU |
| --- | --- |
| Default tracing at 1% | +18%: the tracing library does work even for the 99% it doesn't record |
| Default tracing at 100% | +41%, and 3% of trace data **silently lost** on the slower machine |
| **Our setup:** lite metrics + our own 1% sampling + 1 span per load | **+1.0%** ✅ |

## 8. What exists and what's only designed

| Part | Status |
| --- | --- |
| Problem research, design docs | ✅ Written |
| Data generator + realism checks | ✅ Built and validated |
| Engine core (normalize, dedup, match, alert) | ✅ Built for the benchmark (`bench/overhead/core.ts`); dedup uses a simple rule, not the trained model yet |
| Observability overhead test | ✅ Done: +1.0% with our setup |
| Board and Telegram simulators, scheduler, pollers, full engine, scorer, end-to-end run | ✅ Built (Day 1); first scored run above. No automated tests by choice: checked by scored runs (LLD §15) |
| Search parser (rules + GLiNER2, Qwen fallback) | ✅ Built; five contenders compared on one eval set ([ml/parser/RESULTS.md](ml/parser/RESULTS.md)); one known bug below |
| Observability (Tempo, Loki, Langfuse, Prometheus, a provisioned Grafana dashboard, SLOs with burn-rate alerts) | ✅ Built and running on the server |
| Live mode: always-on world, UI, continuous deploy | ✅ Built and running on the server (below) |
| Trained dedup classifier | ⏳ Not built: dedup still uses the rule-based stand-in |
| Formal load-test harness (step-load runs, DESIGN.md §7) | ⏳ Not built as a separate suite; pushing live mode's speed and volume controls found a real bug (below) |

## Live mode (try it yourself)

Open **http://localhost:8080** (served by the server, through the tunnel). The `live` service never stops and makes a new world every time it starts:

- **New data all the time.** Loads arrive as they would on a real board ([sim/world.ts](sim/world.ts), the same calibrated model the batch generator uses), following the US Central day: busy 7–12, quiet overnight. Each load spreads into postings over its life: refreshes, reposts with new ids, copies on other boards, a co-broker. 300 synthetic dispatchers with ~1,100 saved searches poll the boards alongside you.
- **You are a dispatcher.** Type a search in plain English; the parser (rules + GLiNER2, every call traced in Langfuse) shows what it understood and asks when something is unclear. Save it, and alerts arrive the way the Telegram bot would send them.
- **Scored live.** The answer key is built as each load is born, so the page shows misses, duplicates and post-to-alert latency for everyone and for you, in real time.
- **Push it.** Speed slider (1–120×), freight volume (10K–100K loads/day), and burst buttons (500 loads out of one market at once) to watch queues, 429s and latency react; Grafana shows the same from the engine's metrics. Above ~30× one Node process can't keep up and the UI says so.
- **Removing a search cancels it.** Deleting a saved search also cancels its queued and held alerts (`engine.refreshSearches`), so you don't keep getting alerts for a search you just removed.

**Known issues found this way:**
- **Parser:** "loads out of springfield tmrw" resolves Springfield as the origin, but because the equipment is still missing the model runs too and is asked for a destination; it echoes the same place back, so the dispatcher is asked "Which Springfield?" twice, once for origin and once for destination, instead of once. Not fixed yet.
- **Scheduler under heavy load:** at 120× speed and 100K loads/day, a run banned 541 of 548 logins and missed 86.6% of loads. The scheduler fires each login's next poll on a timer and doesn't check whether that login's previous poll is still in flight, so at high speed hundreds of requests for the same login can be queued before the first response (and its 429) comes back. The fix is a per-login cap of one poll in flight; not built yet.

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

### First end-to-end result

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

## 9. Where to read more

| Document | What's in it |
| --- | --- |
| [DESIGN.md](DESIGN.md) | High-level design: problem, constraints, architecture, decisions and trade-offs, what breaks at 1000x |
| [LLD.md](LLD.md) | Low-level design: data types, in-memory state, APIs, algorithms, failure handling, tests |
| [OBSERVABILITY.md](OBSERVABILITY.md) | What we measure, dashboards, alerts, runbooks, load-test method |
| [SLO.md](SLO.md) | The three service-level objectives, their error budgets, and the burn-rate alerts that watch them |
| [DEPLOY.md](DEPLOY.md) | How the server, continuous deploy and the Mac's SSH tunnel are set up |
| [bench/overhead/RESULTS.md](bench/overhead/RESULTS.md) | The overhead test: method, numbers, lessons |
| [sim/ASSUMPTIONS.md](sim/ASSUMPTIONS.md) | Every number in the fake data, with its source |
