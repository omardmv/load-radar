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
