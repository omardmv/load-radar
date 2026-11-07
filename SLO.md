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

### Engine cluster

Engine containers behind nginx; each starts empty and owns whichever dispatchers' requests reach it, polling the
boards for just those. nginx picks the engine per request by a consistent hash on the dispatcher id. 6,000
dispatchers, 100K loads/day, 1×, 2 min warm-up, 5 min measured; round robin is the rejected alternative.

| | 1 engine | 2 engines | 3 engines | 3 engines, round robin (rejected) |
| --- | --- | --- | --- | --- |
| Board requests/s | 2,989 | **5,590** | **6,052** | 5,618 |
| CPU per engine | 1.00 | 0.99 | 0.77 | 0.96 |
| Alerts within 60 s | 85% | 100% | 100% | 86% |
| Post → alert p50 / p95 | 43 / 100 s | 4.9 / 16 s | 2.9 / 7.5 s | 18 / 220 s |
| Duplicate alerts | 0 | 0 | 0 | 48% |
| Misrouted calls (404, wrong engine) | 0 | 0 | 0 | 54% |
| 429s / bans | 0 / 0 | 0 / 0 | 0 / 0 | 0.34% / 0 |

Maximum with 3 engines: 9,000 dispatchers → 6,728 board requests/s, 100% within 60 s; 12,000 → 6,481/s, 87%
within 60 s (past the limit).

Hashing on the dispatcher id keeps everything about a dispatcher on one engine, so duplicates and misrouted calls
stay at 0. Round robin sends a dispatcher's calls to engines that don't own it: 48% duplicate alerts, 54%
misrouted. nginx rules: one `server` line per engine, `max_fails=0` (one failed request must not move a
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
