# Service level objectives

What "working" means for Load Radar, in numbers a dispatcher would care about. Times are **simulated** seconds: what
the dispatcher experiences, whatever the speed slider says.

| # | SLO | Target | SLI (how it's measured) | Why this number |
| --- | --- | --- | --- | --- |
| 1 | **Alerts are fast** | 99% of alerts reach the dispatcher (web alert channel) within **60 s** of the load being posted | `post_to_alert_seconds` histogram (engine): alerts with `le="60"` ÷ all alerts | A good load is covered in ~20 min (median); the first caller usually wins. A minute is still early; 10 minutes is too late. |
| 2 | **Alerts are complete** | 99% of matching loads that stay on the board **5+ minutes** get an alert | live answer key: `answer_key_settled_total{outcome="delivered"}` ÷ (`delivered` + `missed_open`) | A load taken within a couple of minutes may be gone before any poll could see it (`missed_quick`, doesn't burn budget). A load that sat 5+ minutes with no alert is our fault. |
| 3 | **Boards stay friendly** | **0** banned logins; under **1%** of board requests answered 429 | `engine_gauge{name="logins_banned"}`; `upstream_requests_total` by status | A banned login can't use our product until the board reinstates it — that's an incident, not a budget. A few 429s are normal; many mean the scheduler is wrong. |

## Error budget

The budget is what the SLO allows to go wrong: for SLO 1, 1% of alerts may be slower than 60 s.

- **Window: rolling 1 hour** (a real service would use 28–30 days; the live world restarts on every deploy, so an
  hour is what we can actually observe — the math is the same).
- **Burn rate** = (share of bad events) ÷ (share the SLO allows). Burn rate 1 spends the budget exactly over the
  window; burn rate 10 spends an hour's budget in 6 minutes.
- **Alerts** ([ops/prometheus-rules.yml](ops/prometheus-rules.yml), visible at `http://localhost:9090/alerts`): *fast
  burn* when the 5-minute burn rate is above 10 and the 1-minute one confirms it (multiwindow pattern, scaled to a
  1-hour window); *ban* the moment any login is banned.
- When the budget runs out: stop adding features, fix reliability, and show the improvement on the dashboard.

## Where to look

Grafana → **Load Radar** dashboard → top row **SLOs**: each SLI over the last hour against its target, budget left,
and burn rate over time.

## Measured

### Live at 1×, 300 dispatchers, 30 h

| SLO | Result |
| --- | --- |
| Alerts within 60 s | 100% (p50 2.7 s, p99 9.3 s, ~290K alerts) |
| Loads alerted, open 5+ min | 96–97% (below the 99% target) |
| Board 429s / banned logins | 0 / 0 (33M board requests) |

Duplicates 0.03%. Board request rate ~0.94/s per dispatcher (2,000 dispatchers × 1.8 logins ≈ 1,882/s); board
requests outnumber new loads ~1,600 to 1.

Open: misses aren't logged with a reason, there's no slow-burn alert, and no health check from outside the box.

### Scale steps at 1×: where it breaks

100K loads/day (~60% of DAT), the world on its own thread, 7 min per step (2 warm-up, 5 measured). Each dispatcher
has ~1.8 board logins; each login may poll once a second.

| Dispatchers (logins) | Alerts ≤ 60 s | Loads alerted | Post → alert p50 / p95 | Board req/s | CPU (cores) | Engine event-loop p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 300 (523) | 100% | 100% | 2.7 / 6.2 s | 298 | 0.41 | 0.13 s |
| 1,000 (1,799) | 100% | 100% | 3.3 / 11.3 s | 954 | 1.03 | 0.50 s |
| 2,000 (3,603) | 100% | 100% | 3.3 / 14.8 s | 1,882 | 1.29 | 0.44 s |
| 5,000 (8,950) | **97.3%** (SLO missed) | 100% | **35 / 59 s** | 3,318 | 1.95 | 0.41 s |

The knee is between 2,000 and 5,000 dispatchers. Bottleneck: the engine thread's event loop, which runs 0.4–0.5 s
late from 1,000 dispatchers on — more logins load it, not more freight. One engine thread holds the SLOs to roughly
2,000–3,000 board requests/s.

### Engine workers: 1 vs 2

`--engine-workers N` splits the engine into N threads, each owning 1/N of the dispatchers (logins, alerts, chats),
sharing nothing. Same world for both runs: 8,000 dispatchers, 100K loads/day, 1×, 5 min measured.

| | 1 worker | 2 workers | 2 workers, 12,000 dispatchers |
| --- | --- | --- | --- |
| Board requests/s | 3,745 | **6,617** (1.77×) | 6,098 |
| Process CPU (cores) | 1.9 | 3.5 | 3.4 |
| Alerts within 60 s | 34.6% | 84.5% | 32.3% |
| Post → alert p50 / p95 | 86 / 267 s | 39 / 102 s | 91 / 272 s |
| 429s / bans | 0 / 0 | 0 / 0 | 0 / 0 |

A second worker gives 1.77× the requests on the same load (CPU above one core is the proof both threads ran in
parallel). The 4-core machine's ceiling is ~6,100–6,600 board requests/s: 12,000 dispatchers didn't get more through.

### Push feed: 1 / 2 / 3 workers, hash routing

Partners push each posting as one HTTP POST to nginx, which hashes on the load's lane key (origin state |
destination state | pickup date | equipment) to N ingest workers capped at one core each. 2,000 dispatchers'
searches per worker, 4 min measured.

| | 1 worker | 2 workers | 3 workers |
| --- | --- | --- | --- |
| Postings/s handled | 2,050 | **2,935** (1.43×) | **3,346** (1.63×) |
| Duplicate alerts | 2.7% | 2.2% | 1.7% |
| Alert p50 / p99 | 0.40 / 1.5 s | 0.30 / 1.0 s | 0.24 / 1.0 s |
| Push errors | 0 | 0 | 0 |

Hashing on the lane key sends every copy of a load to one worker, so duplicates stay at the single-worker level.
Round robin (rejected): 43% duplicate alerts — copies of a load scatter across workers, each with its own dedup
memory. nginx rules: one `server` line per worker, `max_fails=0`, 65 s keep-alive on the workers.

### Overload at 30×, with the overload rules

Rules: a poll still queued or running is never queued again; at most one request in flight per login; under alert
backlog, freshest alerts first, alerts older than 10 min dropped, digests of 20.

| SLO | Result |
| --- | --- |
| Alerts within 60 s | 83.7%, p50 29 s |
| Loads alerted, open 5+ min | 87.9% |
| Board 429s / banned logins | 0 / 0 |

The cost moved to completeness: each login holds one request on the wire, so each search's area is polled less
often and some loads are taken before we see them.
