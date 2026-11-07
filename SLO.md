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

### Engine cluster: the maximum on one 4-core server

Engine containers behind nginx, one core each; each starts empty and owns whichever dispatchers' requests reach it,
polling the boards for just those. nginx picks the engine by a consistent hash on the dispatcher id. The simulated
boards run as 4 threads, each owning a share of the logins. 100K loads/day, 1×, 2 min warm-up, 5 min measured.
CPU per container from `docker stats`, whole machine from `/proc/stat` (8 hardware threads on 4 physical cores).

| Engines, dispatchers | Board requests/s | Alerts within 60 s | Post → alert p50 / p95 | Engines CPU | Boards CPU | Whole machine |
| --- | --- | --- | --- | --- | --- | --- |
| 1, 6,000 | 6,050 | 100% | 14 / 28 s | 0.76 | 0.69 | 2.00 |
| 3, 12,000 | 12,096 | 100% | 7.6 / 18 s | 1.82 | 1.53 | 4.04 |
| **4, 15,000** | **15,096** | **100%** | 7.6 / 20 s | 2.56 | 1.73 | 4.95 |
| 5, 18,000 | 17,972 | 98.7% (at the edge) | 15 / 53 s | 3.53 | 2.16 | 6.74 |
| 4, 18,000 | 18,055 | 85% ✗ (engines full) | 27 / 100 s | 3.32 | 2.06 | 6.29 |
| 5, 21,000 | 16,976 | 45% ✗ (machine full) | 66 / 199 s | 4.40 | 2.37 | 7.89 |

0 429s, 0 bans and 100% of loads alerted in every run.

- **Within the SLO: ~15,000 board requests/s (15,000 dispatchers) with 4 engines; ~18,000/s at the edge with 5.**
  Past that the whole machine is busy (7.9 of 8 hardware threads) and throughput falls.
- **Per request:** ~0.17 ms of engine CPU and ~0.11 ms of simulated-board CPU (~0.33 ms for the whole machine).
  One engine core peaks at ~7,150 board requests/s (overloaded, 1 engine at 9,000 dispatchers).
- **What keeps the cost per request low:** the engine's HTTP client uses undici's `request()` (not `fetch()`, which
  builds web objects and a timer per request); the simulated boards parse requests by hand, cache map cells, and run
  as 4 threads, each owning a share of the logins.
- Beyond this box, each engine adds ~4,000–7,000 board requests/s of capacity on its own core (with real boards, the
  board side isn't ours to run).

Round robin instead of hash (3 engines, 6,000 dispatchers): 48% duplicate alerts, 54% of API calls reached an engine
that doesn't own the dispatcher (404), 0.34% of board requests answered 429.

Hashing on the dispatcher id keeps everything about a dispatcher on one engine, so duplicates and misrouted calls
stay at 0. nginx rules: one `server` line per engine, `max_fails=0` (one failed request must not move a
dispatcher to another engine), 65 s keep-alive on engines.

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
