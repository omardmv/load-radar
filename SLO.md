# Service level objectives

> New to the project? Start with [GUIDE.md](GUIDE.md) (Part 8 covers this document in plain language).

What "working" means for Load Radar, in numbers a dispatcher would care about. Every change is judged against these
(SRE book, ch. 4). Times are **simulated** seconds: what the dispatcher experiences, whatever the speed slider says.

| # | SLO | Target | SLI (how it's measured) | Why this number |
| --- | --- | --- | --- | --- |
| 1 | **Alerts are fast** | 99% of alerts reach Telegram within **60 s** of the load being posted | `post_to_alert_seconds` histogram (engine): alerts with `le="60"` ÷ all alerts | A good load is covered in ~20 min (median, `sims/cover.ts`), and the first caller usually wins. A minute is still early; 10 minutes is too late to matter. At 1× the live run measures p99 ≈ 10 s, so this leaves room. |
| 2 | **Alerts are complete** | 99% of matching loads that stay on the board **5+ minutes** get an alert | live answer key (`live/score.ts`): `answer_key_settled_total{outcome="delivered"}` ÷ (`delivered` + `missed_open`) | A load taken within a couple of minutes may be gone before any poll could see it; those are counted (`missed_quick`) but don't burn the budget. A missed load that sat on the board 5+ minutes is our fault. |
| 3 | **Boards stay friendly** | **0** banned logins; under **1%** of board requests answered 429 | `engine_gauge{name="logins_banned"}`; `upstream_requests_total` by status | A banned login is a customer who can't use our product until the board reinstates them. That's an incident, not a budget. 429s are the board telling us to slow down; a few are normal, many mean the scheduler is wrong. |

Not yet measured (next): search box responsiveness (99% of parses answer within 1 s), and polling freshness (each
search's area polled at least every N seconds).

## Error budget

The budget is what the SLO allows to go wrong: for SLO 1, 1% of alerts may be slower than 60 s.

- **Window: rolling 1 hour.** A real service uses 28–30 days; the live world restarts on every deploy, so an hour is
  what we can actually observe. The math is the same.
- **Burn rate** = (share of bad events) ÷ (share the SLO allows). Burn rate 1 spends the budget exactly over the
  window; burn rate 10 spends an hour's budget in 6 minutes.
- **Alerts** (Prometheus rules in [ops/prometheus-rules.yml](ops/prometheus-rules.yml), visible at
  http://localhost:9090/alerts): *fast burn* when the 5-minute burn rate is above 10 and the 1-minute one confirms it
  still is (the SRE workbook's multiwindow pattern, scaled to a 1-hour window); *ban* the moment any login is banned.

## What happens when the budget runs out

Same rule as the book: stop adding features, fix reliability. In this project that means the next change must be one
that moves the SLO back (overload handling, capacity), and it must show the improvement on the dashboard.

## Where to look

Grafana → **Load Radar** dashboard → top row **SLOs**: each SLI over the last hour against its target, budget left,
and burn rate over time.

## Measured (2026-11-04, live world, 300 dispatchers, 20K loads/day)

| SLO | 1× | 30× for 5 min |
| --- | --- | --- |
| Alerts within 60 s (99%) | 100% | **48.8%**, burn rate 52, `AlertLatencyBudgetFastBurn` fired |
| Loads alerted, open 5+ min (99%) | 100% | **92.3%**, burn rate 7.7 |
| Board requests not 429 (99%) | 100% | 100% |
| Logins banned (0) | 0 | 0 |

At normal speed every SLO holds; at 30× the single live process can't keep up and the speed SLO pages within minutes.
An earlier run at 120× and 100K loads/day banned 541 of 548 logins (SLO 3) because hundreds of requests per login were
in flight when the first 429 came back.

### After the overload rules (same 30× test, 5 min)

Changes (SRE ch. 21–22): a poll still queued or running is never queued again (polls ask "what's new since my cursor",
so a copy fetches nothing); at most one request in flight per login; under alert backlog, freshest first, alerts
older than 10 min dropped, digests of 20 instead of 5.

| | Before | After |
| --- | --- | --- |
| Alerts within 60 s (99%) | 48.8% | **83.7%** |
| Post → alert p50 | minutes | **29 s** |
| Loads alerted, open 5+ min (99%) | 92.3% | **87.9%** (worse) |
| Board 429s / banned logins | 0 / 0 | 0 / 0 |
| Alert backlog (held for Telegram) | growing | 0 |
| Board requests | not recorded | 2,630/s |
| Engine CPU / event-loop p99 | not recorded | 1.23 cores / 44 ms |
| Polls coalesced | (no such rule) | 1.76 M in 5 min |

What it means: the overload now goes where it should. Alerts that are sent arrive on time instead of piling up, and
logins can't be banned by our own backlog. The cost moved to completeness: 526 of ~534 logins always have one request
on the wire, ~900 polls wait their turn, and each request takes ~200 ms because the simulated boards share the
engine's single process and core. So each search's area is polled less often and some loads are taken before we see
them. Next: give the boards their own process and the engine more cores (capacity), and test realistic scale at 1×
with more logins, since 30× asks each login for 30 requests a second, which no real board allows.

### Scale steps at 1× (2026-11-04): where it breaks

Real speed, 100K loads/day (~60% of DAT), the world on its own thread, 7 min per step (2 warm-up, 5 measured).
Each dispatcher has ~1.8 board logins; each login may poll once a second.

| Dispatchers (logins) | Alerts ≤ 60 s | Loads alerted | Post → alert p50 / p95 | Board req/s | CPU (cores) | Engine event-loop p99 | Polls waiting for their login |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 300 (523) | 100% | 100% | 2.7 / 6.2 s | 298 | 0.41 | 0.13 s | 1 |
| 1,000 (1,799) | 100% | 100% | 3.3 / 11.3 s | 954 | 1.03 | 0.50 s | 2,440 |
| 2,000 (3,603) | 100% | 100% | 3.3 / 14.8 s | 1,882 | 1.29 | 0.44 s | 5,848 |
| 5,000 (8,950) | **97.3%** (SLO missed) | 100% | **35 / 59 s** | 3,318 | 1.95 | 0.41 s | 13,841 |

- **The knee is between 2,000 and 5,000 dispatchers** on this laptop. Completeness, 429s and bans held at every
  step; the speed SLO is the first to go.
- **Bottleneck: the engine thread.** Its event loop runs 0.4–0.5 s late from 1,000 dispatchers on, so each board
  request takes longer to send and read (at 5,000: 8,676 logins busy ÷ 3,318 req/s ≈ 2.6 s per request), polls queue
  behind their login, and alerts arrive later. The world thread stays below 0.2 s. More logins, not more freight,
  is what loads the engine: postings processed rose from 12/s to 134/s only because each login fetches its own copy.
- **Capacity:** one engine thread handles ~2,000–3,000 board requests per second within the SLOs, about 3,000
  dispatchers. The next lever is more engine workers, each owning a share of the logins (logins are independent, so
  this splits cleanly). At that rate 1M requests/s would be ~300–500 such workers.

### Scale-out: 1 vs 2 engine workers (2026-11-07)

`--engine-workers N` splits the engine into N threads, each owning 1/N of the dispatchers (their logins, alerts and
chats), so the shards share nothing. Same world for both runs: 8,000 dispatchers (more than one thread can serve),
100K loads/day, 1x, 2 min warm-up, 5 min measured (`scripts/core-steps.sh`). The 4 Telegram bots are split between
the workers, so delivery capacity is the same in both runs.

| | 1 worker | 2 workers | 2 workers, 12,000 dispatchers |
| --- | --- | --- | --- |
| Board requests/s | 3,745 | **6,617** (1.77x) | 6,098 |
| Process CPU (cores) | 1.9 | 3.5 | 3.4 |
| Alerts within 60 s | 34.6% | 84.5% | 32.3% |
| Post -> alert p50 / p95 | 86 / 267 s | 39 / 102 s | 91 / 272 s |
| Engine event-loop p99 | 0.96 s | 1.39 s | 1.43 s |
| World thread event-loop p99 | 0.16 s | **0.78 s** | 0.38 s |
| 429s / bans | 0 / 0 | 0 / 0 | 0 / 0 |

- A second worker gives 1.77x the requests on the same load. CPU above one core is the proof the two threads ran in
  parallel (one thread can't use more than one core).
- Not 2x because the simulated boards share the same 4 cores: their thread went from 0.16 s to 0.78 s late.
- The machine's ceiling is ~6,100-6,600 board requests/s: 12,000 dispatchers didn't get more through. 8,000 is still
  beyond 2 workers (84.5%, not 99%), so the SLO-safe capacity is roughly 2x the single-thread ~3,000 dispatchers.
- Not tested: workers on separate machines, a worker dying and its logins moving (that needs leases, LLD section 12).

### Push feed behind a load balancer (2026-11-07)

The shared lane (DESIGN.md 3.5): partners push each posting as one HTTP POST to nginx, which spreads them over N
ingest workers capped at **one core each** (`cpus: 1`). 2,000 dispatchers' searches in every worker, generator sending
as fast as it's answered, 1 min warm-up, 4 min measured (`scripts/feed-steps.sh`). Live mode stopped meanwhile.

| | 1 worker | 2 workers, hash | 3 workers, hash | 3 workers, round robin |
| --- | --- | --- | --- | --- |
| Postings/s handled | 2,050 | **2,935** (1.43x) | **3,346** (1.63x) | 3,250 |
| CPU per worker (max) | 1.00 | 0.97 | 0.95 | 0.85 |
| Alerts per posting | 14.5 | 13.6 | 13.1 | **22.5** |
| Duplicate alerts (1-in-10 sample of loads) | 2.7% | 2.2% | 1.7% | **43.4%** |
| Alert p50 / p99 | 0.40 / 1.5 s | 0.30 / 1.0 s | 0.24 / 1.0 s | 0.22 / 1.4 s |
| Push errors | 0 | 0 | 0 | 0 |

- **Throughput scales with workers**: 1.43x with 2, 1.63x with 3. Not linear because the generator (~1-1.3 cores) and
  nginx share the same 4 cores as the workers; the third worker mostly takes what's left of the machine.
- **Routing must follow the state.** Each worker deduplicates in its own memory. Hashing on the load's lane key sends
  every copy of a load to one worker: duplicates stay at the single-worker level (2-3%, dedup's own misses, mostly
  reposts more than 6 h after the first post). Round robin scatters the copies: 43% duplicate alerts, 1.6x the alerts.
- **Two nginx bugs found on the way**, both silent (no errors in the client's view at first):
  1. `server feed-ingest:7200` (one name resolving to every replica) made `hash` rotate through the addresses: 300
     requests with one key went 100/100/100. One `server` line per replica fixed it (probe: 0/0/300).
  2. Through nginx, 2 workers still gave **14.5%** duplicates vs **2.3%** with the generator hashing to the workers
     itself. Cause: Node closes idle keep-alive sockets after 5 s, nginx reuses them for 60 s; each reset counted as a
     worker failure, and by default (`max_fails=1 fail_timeout=10s`) nginx then took that worker out for 10 s and
     re-hashed its loads to another worker, whose dedup memory had never seen them. Fixed with `max_fails=0` (a
     stateful worker must not be skipped for one error) and a 65 s keep-alive on the workers: errors 0, duplicates 2%.
- In production a partner won't send our routing key; a stateless edge tier (or Kafka's partition key) computes it.

## Live review, 2026-11-04 to 11-06 (30 h at 1×, 300 dispatchers)

| SLO | Measured |
| --- | --- |
| Alerts within 60 s | 100% (p50 2.7 s, p99 9.3 s, ~290K alerts) |
| Loads alerted, open 5+ min | **96–97%, below target the whole time** |
| Board 429s / banned logins | 0 / 0 (33M requests) |

The completeness miss never paged: burn rate was ~3.5, and the only rule is the fast burn (> 10). Two causes found:

1. **Truckstop names cut at 14 characters didn't resolve** when normalizing changed their length ("FORT LAUDERDAL"
   -> "FT LAUDERDAL") or the cut landed in an alias ("ONTARIO (INLAN"). ~2,000 Truckstop postings dropped in 30 h.
   Fixed in the gazetteer: Truckstop place failures 1.38% -> 0.01% on a generated 144K-posting world.
2. **The live scorer started the clock at the first posting on any board.** A dispatcher whose only copy is a
   co-broker repost (~10 min later, another board) was counted missed after 15 min, then "late" (611 in 30 h).
   Fixed in both scorers; on the same eval deliveries p95 latency re-scores 120 s -> 5.3 s.

Still open: misses aren't logged with a reason, there's no slow-burn alert, and no health check from outside the box.
