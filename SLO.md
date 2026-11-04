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
