# Service level objectives

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
