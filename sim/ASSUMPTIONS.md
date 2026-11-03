# Simulator assumptions

Every number the load tests depend on, where it came from, and how sure I am. `node sim/validate.ts out/` recomputes these from `truth.ndjson` and fails if the generated data drifts away from the real references. Challenge any of these in review.

## Validated against real data

The value for each row is from seed 1, 100K loads (287,905 postings). Seeds 2 and 3 pass too.

| What | Generated | Real reference | Source | Confidence |
| --- | --- | --- | --- | --- |
| Equipment share of postings | van 41%, reefer 18%, flatbed 41% | van 38–44%, reefer 17–19%, flatbed 38–44% | DAT weekly load-post counts, Mar–May 2026 (e.g. week of Mar 29: van 1.36M, reefer 0.65M, flatbed 1.57M of 3.58M) | High |
| Mean trip length | van 490, reefer 603, flatbed 371 mi | van 439, reefer 610, flatbed ~330 (DAT); all truckload 522–571 (SONAR, 2025) | DAT length-of-haul blog (data through early 2022), FreightWaves SONAR 2025 | Medium: DAT figure is older, so targets sit between it and SONAR |
| $/mi with fuel, hauls ≥ 250 mi | van 3.06, reefer 3.61, flatbed 3.62 | same | DAT Trendlines, week of 2026-10-19. DAT benchmarks cover hauls ≥ 250 mi, so calibration uses only those | High |
| Short-haul premium (van) | <500 mi ÷ 1000–2000 mi = 1.45 | 1.42 ($3.20 vs $2.25) | Nuvocargo 2026 dry van guide | Low (broker guide, not index data) |
| Postings with no rate | 30% | 29% | Public load board sample, 400 rows, 2026-11-03 | Medium |
| Pickup date | 51% same day, 32% next day | 51%, 32% | same sample | Medium |
| Exact duplicate rows (same board, lane, equipment, rate, pickup) | 52% | 54% | same sample | Low: that board is small and flatbed-heavy |
| Lanes posted by 2+ companies (one board, ~6,000 postings) | 6% | 8% | same sample. Measured at the same board size, because this metric grows with sample size | Low |

## Real data used directly

| What | Source |
| --- | --- |
| 3,000 active brokers (MC number, name, city) | FMCSA licensing data, `data.transportation.gov` dataset `6eyk-hxee`, `broker_stat = 'A'`, pulled 2026-11-03 |
| 14,853 US towns (population ≥ 1,000, coordinates) within 150 mi of a market; neighborhoods removed | GeoNames `cities1000` (CC BY 4.0), downloaded 2026-11-03. Real postings start in small towns (Abbeville AL, Ackerman MS), not just metros |
| Board quirks: `$0` for no rate, city names cut at 14 characters, weight in thousands labeled "lbs", combined equipment like "Flatbed/Step Deck" and "Van/Reefer", free-text comments (tarps, temperature, pay terms) | Seen on the public board sample |

## Modeled (assumptions)

| What | Value | Why |
| --- | --- | --- |
| Lane volume | Gravity model over 65 markets: `(pop_o^0.6 · heat_o) · pop_d^0.6 / miles^α`. α is solved per equipment so mean trip length hits the targets above (α ≈ van 1.38, reefer 1.21, flatbed 1.63). Same-market lanes weighted 0.1 | Standard freight gravity model. `heat` is a hand-set outbound multiplier for known heavy markets. FAF5 flows could replace it |
| Origin point | 35% the metro itself, else a nearby town weighted by √population | Matches a few big shippers per metro plus many small ones |
| Reefer origins | 3× outbound pull from produce/food markets | Reefer freight clusters around produce |
| Rate spread | per-market factor (σ 6%, hotter markets higher), per-load noise (σ 10%), minimum $300, rounded to $25 | Short-haul minimum charges are standard practice; the exact floor is a guess |
| Broker concentration | Zipf, exponent 1.1 | A few big brokers post most loads (the sample board was even more concentrated) |
| Reposts | each listing is refreshed or reposted with probability 0.5 per step, ~every 30 min; half keep the same board ID (refresh), half get a new one (delete and post again) | Tuned to the 54% duplicate-row rate. Dedup must handle both cases |
| Cross-posting | 30% of loads also go on other boards (40% chance per board), ~90 s later; 30% of those change the rate by ±$25–50, 10% drop it | No public data. This is the cross-board dedup stress |
| Co-brokering | 8% of loads re-posted by a second broker at 88–95% of the rate | Seen on the sample board (same lane, two companies). Dedup can't key on broker MC alone |
| Recurring freight | 10% of loads have 1–2 siblings: same lane, next pickup days | Seen on the sample board. These are **separate** loads, and dedup must not merge them |
| Board share | DAT 50%, Truckstop 30%, two portals 12% / 8% | Assumption |
| Time of day | US Central curve, busy 7:00–12:00 (peak minute ≈ 2.7× average) | Assumption |
| Volume | `--loads` counts real loads; each becomes ~2.9 postings. DAT's ~3.6M posts a week ≈ 500K a day ≈ `--loads 170000 --hours 24` | DAT weekly totals, 2026 |
| Users | DAT credential 85%, Truckstop 50%, portals 25% / 15%; ~4 saved searches each (lognormal) | Assumption |
| Saved searches | 75% from home market; truck at the metro (60%) or a nearby town; deadhead 50–150 mi; destination 50% anywhere, 30% 1–3 states, 20% market + radius; 30% no rate floor | Assumption |
| Natural-language phrasings | 3 templates (clean, casual, all-caps shorthand) | Real phrasing is messier |

## Known gaps

- **Same-state share is 32%, and no trustworthy reference exists.** The sample board shows 3.3%, but it's small and biased. Census freight surveys say most truck *tons* stay in-state, but that's mostly local hauls under 50 miles, which don't appear on load boards. Hitting DAT's short flatbed trips puts many loads inside big states (Texas, California), so `validate.ts` reports this number without failing on it.
- Lane-level volumes aren't checked against real lane rankings. DAT publishes regional rankings, not city lanes.
- The board simulator still has to add board behavior: loads being covered and removed, rate limits, 429s and bans.
