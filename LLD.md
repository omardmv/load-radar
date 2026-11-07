# Load Radar: low-level design

> New to the project? Start with [GUIDE.md](GUIDE.md) (Parts 3 and 5 cover this document in plain language).

[DESIGN.md](DESIGN.md) is the high-level design: the problem, the constraints, the parts and why they exist. This document is the low-level design: data types, state, APIs, algorithms, failure handling and tests, detailed enough to build from.

Everything here targets the demo (Node/TypeScript) — originally time-boxed to 2 days on one laptop, now built out further and running continuously on a server (DEPLOY.md). Section 13 says what changes in production.

---

## 0. The rule this design follows

> Connection pool limits and N+1 queries usually bite long before the database does. Fix those first, then talk Redis.

So the order is:

1. **No shared store on the hot path.** Each stage keeps its state in memory, owned by exactly one worker (partitioned by key). A lookup costs ~0.1 µs instead of a ~100–200 µs network round trip, and there is no store-side N+1 to have.
2. **Fix what remains, which is upstream:** HTTP socket pools to the boards (section 9) and N+1 calls to board APIs (section 9).
3. **Add a shared store or log only when a measurement asks for it.** Section 12 lists the triggers. Redis isn't banned; it just needs a reason.

## 1. Processes

| Process | What runs inside | Talks to |
| --- | --- | --- |
| `engine` | api, planner, scheduler, pollers, normalizer, dedup, matcher, alert queue, notifier, as modules connected by in-memory queues | boards-sim and telegram-sim over HTTP; searches and credentials from a flat file (batch) or passed in by the caller (live mode); no snapshot file yet (section 7 is the design, not built) |
| `boards-sim` | replays `out/postings.ndjson` with budgets, 429s, bans, covered loads | — |
| `telegram-sim` | enforces Telegram rate limits, logs deliveries | — |
| `scorer` | offline, compares deliveries with the answer key | files |
| `live` | one always-on process, 2 + N threads. **World thread** (`live/world-worker.ts`): `sim/world.ts` as a stream, boards-sim and telegram-sim on 127.0.0.1:7001/7002, the rolling answer key. **Engine workers** (`live/engine-worker.ts`, `--engine-workers N`): N engines, each owning 1/N of the dispatchers, metrics on :9464+i. **Main thread** (`live/server.ts`): the UI's HTTP + SSE API, the search parser and the load-decision agent; the engine too when N = 0 | the threads exchange messages (clock anchor, searches, stats, postings, alerts, load facts); the engine reaches the simulators over HTTP; outside the container: GLiNER2, Ollama, the collector, the browser; saved searches persist in the `live_state` volume |

Infrastructure in `docker compose` (DEPLOY.md): OpenTelemetry Collector, Tempo, Loki, Prometheus, Grafana (observability), GLiNER2 and Ollama (the search parser's models), self-hosted Langfuse, and the `live` service itself. All of it runs continuously on one Linux server; `app` is the only service that runs on demand.

**Start with one thread, measure, then split.** Node runs JavaScript on one thread, which also makes every in-memory update atomic for free. If CPU profiling shows that one core is the limit (most likely JSON parsing of board responses), move pollers plus normalizer into `worker_threads`, partitioned by `hash(credentialId)`. Every stage has its partition key defined from day one (section 3), so splitting is a routing change, not a redesign.

## 2. Data model (TypeScript types)

```ts
type Equip = 'van' | 'reefer' | 'flatbed';
type Board = 'dat' | 'truckstop' | 'portal_a' | 'portal_b' | 'shared';

// A user's saved search, after parsing and confirmation.
interface SearchSpec {
  searchId: string; userId: string;
  origin: { lat: number; lon: number; label: string };
  deadheadMi: number;                        // 25..300
  dest: { kind: 'anywhere' } | { kind: 'states'; states: string[] } | { kind: 'point'; lat: number; lon: number; radiusMi: number };
  equipment: Equip[];
  minRpm: number | null;
  includeNoRate: boolean;                    // default true: show "no rate, call to negotiate"
  pickupWithinDays: number;                  // 0..7
  boards: Board[];                           // which of the user's logins to use
  createdAt: number; version: number;
}

// One customer login on one board. The secret is stored encrypted and never logged.
interface Credential {
  credentialId: string; userId: string; board: Board;
  status: 'active' | 'paused' | 'banned';
  budgetPerMin: number;                      // requests allowed per minute (board-specific)
  pausedUntil: number | null; consecutive429: number;
}

// One query the scheduler runs repeatedly: one login, one merged board query.
interface PlanEntry {
  entryId: string; credentialId: string; userId: string; board: Board;
  query: { lat: number; lon: number; radiusMi: number; equipment: Equip[]; pickupFrom: string; pickupTo: string };
  searchIds: string[];                       // the searches this entry serves
  heat: number;                              // expected new matching postings per minute (EWMA)
  intervalMs: number;                        // from the budget allocation (section 6.3)
  nextAt: number; cursor: number;            // next run time; newest postedAt seen (poll asks only for newer)
}

// What a poller hands to the normalizer: untouched board JSON plus where it came from.
interface RawPosting {
  board: Board; credentialId: string | null; userId: string | null;   // null for shared feeds
  entryId: string | null; fetchedAt: number; raw: unknown;
}

// The one schema everything after the normalizer uses.
interface Load {
  key: string;                               // `${board}:${boardLoadId}`
  board: Board; boardLoadId: string;
  brokerMc: string; brokerName: string;
  origin: { lat: number; lon: number; city: string; state: string; cell: string };   // cell = geohash level 4 (~29×20 km): dedup blocks
  dest:   { lat: number; lon: number; city: string; state: string; cell: string };   // matcher uses level 3 = cell.slice(0, 3)
  equipment: Equip; equipmentDetail: string;
  rate: number | null; miles: number; weightLbs: number | null;
  pickupDate: string;                        // YYYY-MM-DD, US Central
  postedAt: number;                          // the board's timestamp: the start of the latency clock
  comments: string;
  visibleTo: { kind: 'all' } | { kind: 'user'; userId: string; credentialId: string };
  contentHash: string;
  canonicalId?: string;                      // set by dedup
}

interface Alert {
  alertId: string; userId: string; canonicalId: string; searchIds: string[];
  summary: string;                           // "Chicago, IL → Atlanta, GA · Van · $1,950 · 716 mi · pickup today"
  postedAt: number; enqueuedAt: number; deadline: number;
}
```

## 3. State: where everything lives

Hot-path state is in memory. Each piece has exactly one owner, so there's no locking and no shared store.

| State | Structure | Size at demo scale | Eviction | Owner, partition key | Survives restart via |
| --- | --- | --- | --- | --- | --- |
| Searches, credentials (source of truth) | **Design: SQLite tables. Built: a flat file** — `searches.ndjson` (batch) or one JSON file per live-mode user (`live_state` volume) | ~20K + ~8K rows | none | api; cold path | the file itself; a real deployment would use a database (section 13) |
| Plan entries + schedule | `Map<entryId, PlanEntry>` + **min-heap** on `nextAt` | ~10K | rebuilt on search change | scheduler, `credentialId` | rebuilt from searches (cursors from snapshot) |
| Login budgets | `Map<credentialId, TokenBucket>` | ~8K | none | scheduler, `credentialId` | snapshot (else start conservatively at half budget) |
| Dedup "seen" | `Map<board:id, contentHash>` in **hourly buckets** | ~300K | drop the oldest bucket after 72 h | dedup, block key | snapshot |
| Dedup candidate blocks | `Map<blockKey, Entry[]>` (entries hold classifier features) | ~100K canonical loads | same hourly buckets | dedup, block key | snapshot |
| Canonical loads | `Map<canonicalId, Load>` | ~100K | 72 h | dedup | snapshot |
| Heat per cell | `Map<cell3|equip, EWMA>` | ~thousands | none | dedup → planner | snapshot |
| Matcher index + specs | `Map<cell3|equip, Set<searchId>>` + `Map<searchId, SearchSpec>` | ~20K specs × 6–20 cells | rebuilt on search change | matcher, `cell3` | rebuilt from the searches file/store on start, and by `engine.refreshSearches()` whenever live mode's searches change |
| Alerted keys `(user, load)` | `Set<string>` in hourly buckets | ~100K | 72 h | matcher, `cell3` (then the alert stage, `userId`) | snapshot (this matters most: it prevents repeat alerts after a restart) |
| Alert queue | binary heap on `postedAt` (pop min or max, section 6.8) | small | deadline drop | notifier | lost on crash (accepted, section 8) |
| Telegram buckets | token buckets per bot and per chat | ~users | idle 1 h | notifier, `chatId` | not needed |

**Memory note:** Node's garbage collector slows down with millions of small objects. Keep entries compact (short string keys, numbers not objects where possible), drop whole hourly buckets instead of deleting items one by one, and watch `heap_used_bytes` and GC pause time (section 10). Large heaps are one of the first things to break on a single machine (section 11).

## 4. Inside the engine: stages and queues

```
api ─▶ planner ─▶ scheduler ─▶ [poll queue] ─▶ pollers ─▶ [raw queue] ─▶ normalizer ─▶ [norm queue]
                                                                                            │
 telegram ◀─ notifier ◀─ [alert heap] ◀─ matcher ◀─ [new-load queue] ◀─ dedup ◀──────────────┘
```

- Every arrow is a **bounded** queue (ring buffer) with a length metric and a wait-time metric.
- **Backpressure** is built in: when a queue is full, the producer `await`s instead of piling up work. The scheduler watches the poll queue and stretches intervals when pollers fall behind (section 6.3). Polling slower is better than queuing stale polls.
- **Overload rules on the poll path** (`src/engine.ts`): an entry still queued, waiting for its login, or running is never queued again (`polls_coalesced`), so the poll queue can't grow past the number of plan entries; and each login has at most **one request in flight** (`busyLogins`, `waitingForLogin`), so a 429 can pause a login before more requests reach the board.
- Each stage processes **batches** (whatever is waiting, up to N) per turn of the event loop, so a burst doesn't starve other stages, and `nodejs_eventloop_lag_seconds` stays low.

## 5. APIs

### 5.1 Public API (inside `engine`), production design

Not built in this form. What runs today is live mode's API (section 6.10): same ideas, one user, no credentials endpoint.

| Method | Path | Body / response |
| --- | --- | --- |
| `POST` | `/searches` | `{text}` → `{draftId, spec, confirmation: "Reefer from within 100 mi of Fresno, CA, ≥ $3.40/mi. Correct?", parser: "rules" or "llm"}` |
| `POST` | `/searches/{draftId}/confirm` | optional edits → `201 {searchId}`; rebuilds that user's plans and index entries |
| `GET` | `/searches` | the user's searches |
| `DELETE` | `/searches/{id}` | removes it and rebuilds |
| `POST` | `/credentials` | `{board, username, secret}` → `{credentialId}`; secret stored encrypted |
| `GET` | `/healthz`, `/metrics` | liveness, Prometheus |

### 5.2 Board simulator (`boards-sim`): the contract pollers code against

```
GET /{board}/loads?lat=41.88&lon=-87.63&radius=100&equipment=van,reefer&pickup_from=2026-11-04&pickup_to=2026-11-06&since=1793772000000
X-Credential: dat-9dbe45b5
```

| Response | Meaning |
| --- | --- |
| `200` + array of that board's raw postings (formats exactly as `sim/gen.ts` writes them) | ok; only postings already "posted" at simulated time and not yet covered |
| `429` + `Retry-After: s` | over this credential's budget |
| `403 {"error":"account_suspended"}` | banned after repeated abuse (simulates DAT suspending an account) |
| `5xx` / slow response | injected faults for the board-outage test |

The simulator replays `postings.ndjson` on a clock (real time or N× speed). It removes a load once it is "covered" (lognormal ~20 min after first posting, shorter on hot lanes). It enforces a per-credential budget (default 60 requests/min, a made-up number) and bans after more than 20 rejected requests in 10 minutes. Each list response already contains every field the pipeline needs, so there is no per-load detail call (section 9).

### 5.3 Telegram simulator (`telegram-sim`)

`POST /bot{botId}/sendMessage {chat_id, text}` returns `200`, or `429 {"parameters":{"retry_after":s}}` beyond 30 messages/s per bot or 1/s per chat. Every accepted message is logged with its receive time for the scorer.

## 6. Components in detail

### 6.1 Search parser

Code: `src/parse/`. Measured comparison: `ml/parser/RESULTS.md`. LLM observability: OBSERVABILITY.md §8b.

```
extract spans:   rules (regex)  ──► model only if rules miss equipment or origin (GLiNER2 service, or Qwen via Ollama)
normalize:       places (exact, alias, typo, ambiguity) · states · regions · numbers · defaults
questions:       missing equipment, unknown or ambiguous places, directions ("north"), "LA" (Louisiana or Los Angeles?)
confirm:         "Reefer · within 100 mi of Fresno, CA → anywhere · ≥ $3.40/mi"
```

- **Extractors find spans; one normalizer interprets them,** so rules, GLiNER2 and an LLM are compared on equal terms.
- **Never guess silently.** A forced-choice model always answers (the spike classified "need loads out of dallas" as flatbed); an `unspecified` label plus a 0.6 confidence threshold turns that into a question.
- **Defaults:** destination anywhere, deadhead 100 mi, no rate floor, destination radius 150 mi.
- **Ambiguous place:** the same name in two or more states with population ≥ 50,000 each (Columbus OH/GA, Kansas City MO/KS).
- **Every model call is a GenAI span** (`src/obs/llm.ts`): prompt, model, output, tokens, latency, errors → Langfuse, Tempo (via the collector's default trace pipeline), Prometheus (span metrics).
- **Not supported yet:** exclusions ("anywhere but NY") and multi-stop searches; the eval set keeps an example so the gap stays visible.
- **Known bug:** a lone ambiguous place name can get picked up as both origin and destination. "loads out of springfield tmrw" has no equipment, so hybrid mode calls the model even though the rules already found `originText = "springfield"`; the model is asked for a `destination` entity too (`src/parse/gliner.ts`'s `SCHEMA`) and can return the same place for it. Because `parseSearch` (`src/parse/parse.ts`) only fills fields the rules left empty, that guess becomes `destText`, and the dispatcher is asked "Which Springfield?" twice: once for origin, once for destination. Not fixed yet.

### 6.2 Planner

Runs when a user's searches change, and every 10 minutes to refresh heat. It loads a user's searches and credentials with **one query each**, not one per search (the cold path's only N+1 risk).

```
for each user, for each board the user has a credential for:
  S = the user's searches that use this board
  group S by equipment set
  for each group: greedy merge of origins:
     start with the search having the largest deadhead
     merge another search if one circle (center = weighted midpoint, radius = max distance + its deadhead) covers both, and radius <= 150 mi
  each merged group -> one PlanEntry (query covers the union; the matcher filters exactly afterwards)
```

**Heat** for an entry is the sum of the heat EWMAs over the level-3 cells its circle covers. Dedup updates those EWMAs as new loads arrive (α = 0.1 per minute).

Merging trades upstream requests for local filtering. With ~4 searches per user that mostly start at the home market, this should cut requests by 2–3×. The load test measures the real ratio.

### 6.3 Scheduler

**Budget allocation (when to poll each entry).** One credential has a budget of `B` requests per minute shared by its entries. Entry `i` gets new matching loads at rate `λᵢ` (its heat). If it's polled `fᵢ` times a minute, a load waits on average `1/(2fᵢ)` minutes before it's seen. Minimizing total expected delay `Σ λᵢ/(2fᵢ)` subject to `Σ fᵢ = B` (Lagrange multipliers) gives

```
fᵢ = B · √λᵢ / Σⱼ √λⱼ          then clamp each to [1/5 min, 12/min] (between every 5 min and every 5 s)
```

Busy lanes are polled more often, but in proportion to the square root of their rate, so quiet entries still get checked. `intervalMs = 60000 / fᵢ`, plus ±10% jitter each run. The rule is exact only if loads arrive randomly at a steady rate; real arrivals are burstier, so treat it as a strong starting point.

**Main loop:**

```
loop:
  sleep until heap.peek().nextAt (or 20 ms, whichever is sooner)
  while heap.peek().nextAt <= now:
    entry = heap.pop()
    cred = credentials.get(entry.credentialId)               // in memory: no round trip
    if cred.status != 'active' or cred.pausedUntil > now: entry.nextAt = cred.pausedUntil; heap.push(entry); continue
    if !buckets.get(cred.id).take(): entry.nextAt = buckets.nextTokenAt(cred.id); heap.push(entry); continue
    pollQueue.push(entry)                                     // bounded; awaits if full (backpressure)
    entry.nextAt = now + entry.intervalMs × stretch × jitter; heap.push(entry)
```

`stretch` is 1 normally and grows when the poll queue's oldest item waits more than 1 s.

**Reacting to board responses** (reported back by pollers):

| Response | Action |
| --- | --- |
| `200` | `consecutive429 = 0` |
| `429` | `consecutive429++`, `pausedUntil = now + min(15 min, max(Retry-After, 2^n × 5 s))` with jitter. Waiting less than the board's Retry-After only earns more 429s |
| 3 × `429` within 10 minutes | **circuit open**: pause this credential for 15 min, halve its budget for an hour, increment `login_paused_total` |
| `403 account_suspended` | `status = banned`, stop every entry for it, notify the user, increment `login_banned_total` (SLO: always 0) |

### 6.4 Pollers

- A pool of async tasks taking entries from the poll queue. **Concurrency per board is capped by a semaphore sized with Little's law** (section 9), and the HTTP agent for that board has the same socket count, so requests never queue invisibly inside the HTTP client.
- Timeout 5 s, no retry inside the poller. The scheduler owns retry timing so the budget logic stays in one place.
- The query uses `since = entry.cursor` so only new postings come back. After a success the cursor moves to the newest `postedAt`.
- One request per poll; never a follow-up call per returned load (section 9).
- Each returned posting goes to the raw queue with `credentialId`, `userId`, `entryId` and `fetchedAt`.

**Shared feeds** don't go through the scheduler. One reader per feed fetches once for everyone and pushes postings with `credentialId = null`, which becomes `visibleTo = all`.

### 6.5 Normalizer

One adapter per board, matching the formats `sim/gen.ts` writes:

| Field | `dat` | `truckstop` | `portal_a` | `portal_b` |
| --- | --- | --- | --- | --- |
| id | `id` | `loadId` (number) | `ref` | `ref` |
| origin | `"City, ST"` | `originCity` (**upper case, cut at 14 chars**) + `originState` | `lane.from.{city, st}` | `"CITY, ST"` |
| equipment | `V`, `VR`, `R`, `F`, `FD` | `VAN`, `VAN/REEFER`, `REEFER`, `FLATBED`, `STEP DECK`… | `"Dry Van 53'"`, `"Reefer 53'"`, `"Flatbed 48'"`, `"Step Deck 48'"` | `"Van"`, `"Flatbed/Step Deck"`… |
| rate | number or `null` | `"$2,275.00"` or `"$0"` | `price.amount` or `null` | `"$775"` or `"$0"` |
| weight | `weight_lbs` | `"17,000 lbs"` | none | `"38.00 lbs"` → **× 1000** |
| pickup | `YYYY-MM-DD` | `MM/DD/YYYY` | `pu.earliest` (ISO) | `MM-DD-YYYY` |
| posted | `posted` (ISO) | `postedAt` (ms) | `created` (ISO) | `created_at` (s) |
| broker | `company.{name, mc}` | `broker.{companyName, mcNumber "MC…"}` | `broker_mc` | `company`, `mc` |
| miles | `trip_mi` | `mileage` | computed | computed |

**Equipment mapping:** `V, VAN, Dry Van → van`; `R, REEFER → reefer`; `F, FD, FLATBED, STEP DECK, Flatbed/Step Deck, Flatbed (w/Tarps) → flatbed`. `VR` and `Van/Reefer` → `van`, with `equipmentDetail` kept so reefer searches can opt in. Anything unknown is dropped and counted in `normalize_unknown_equipment_total`.

**Place lookup** (gazetteer, built once in memory):
1. Exact match on `normalize(city) + state`, where normalize means upper case, no punctuation, and `ST/SAINT`, `FT/FORT`, `MT/MOUNT` unified.
2. Aliases: `LA → Los Angeles`, `Vernon → Los Angeles`, `Kansas Cty → Kansas City`, and so on.
3. **Truncation:** if the name is exactly 14 characters, prefix-match within the state (`SAINT JOHNSVIL` → `St. Johnsville`).
4. Otherwise fuzzy-match within the state (Jaro-Winkler ≥ 0.92). If that fails, drop the posting and increment `normalize_unknown_place_total`.

Then: `cell = geohash(lat, lon, 4)` (the matcher uses its first 3 characters), `contentHash = sha1(board, id, rate, pickupDate, origin, dest, equipment)`, and `visibleTo` comes from the `RawPosting`.

### 6.6 Dedup

**Stage 1: exact (most postings stop here)**

```
prev = seen.get(board:id)
if prev == contentHash:  refresh of a known posting -> update lastSeen, emit nothing
if prev exists, differs: same posting edited (usually the rate) -> update canonical, emit 'updated'
if no prev:              seen.set(board:id, contentHash), go to stage 2
```

The generator's reposts with a **new** id, cross-posts, and co-broker copies all reach stage 2.

**Stage 2: same-load classifier**

*Built (2026-11-04): logistic regression trained on answer-key pairs; features, threshold policy, results and limits in [ML.md](ML.md).*

- **Candidates:** the block `(pickupDate, oCell, dCell, equip)` plus the 8 neighboring origin cells (a town can sit on a cell edge), limited to postings within the last 6 hours. Block entries carry the classifier's features, so scoring needs no extra lookups.
- **Features per candidate pair:** relative rate difference; whether either rate is missing; same broker MC; Jaro-Winkler similarity of origin and destination names; origin and destination distance in miles; difference in posting time; same board or not; weight difference; same `equipmentDetail`.
- **Model:** logistic regression, trained on pairs from the generator's answer key. Positive pairs are postings of the same `load_id`. Negative pairs are the hard ones: **siblings** (same lane, same broker, different pickup day), which the pickup-date block already separates but are checked anyway, plus same-lane loads from different brokers.
- **Threshold:** a false merge hides a real load (a missed alert); a false split sends a duplicate. A miss costs the customer more, so the threshold targets merge precision ≥ 99.5% on held-out data, accepting some duplicates. The scorer measures both.
- **Result:** match means joining the candidate's `canonicalId`; no match means a new canonical load added to the block. Either way, emit to the new-load queue.

**Visibility is not merged.** (Implemented as a set of `(customer, load)` pairs already matched; the first end-to-end run showed that skipping refreshes per posting alerted only the first customer to fetch a load.) Two users who each find the same load through their own logins share one canonical load, but each arrival carries its own `visibleTo`, so each user can be alerted once. A shared-feed copy makes the canonical load visible to all.

Partition key: `hash(pickupDate, oCell, equip)`, so all candidates for one load live with one owner.

### 6.7 Matcher

**Index**, in memory, rebuilt from SQLite at start and updated whenever a search changes:

```
index: Map<`${cell3}|${equip}`, Set<searchId>>          // cell3 = geohash level 3, ~117 × 157 km near Chicago
specs: Map<searchId, SearchSpec>                        // full specs in memory: no lookup per candidate
a search is added to every level-3 cell whose rectangle comes within deadheadMi of its origin
(distance from the origin to the nearest point of the cell <= deadheadMi)
```

That covering rule guarantees no misses: if a load is within the deadhead, its cell touches the circle, so the search is in that cell's set. The cell is coarse on purpose, and the exact distance check below removes false candidates.

**Why level 3 and not level 4.** Measured for a Chicago search: deadhead 75 mi covers 6 cells at level 3 vs 99 at level 4; deadhead 175 mi covers 20 vs 474. Index size is searches × cells per search, so level 4 means millions of entries today and billions at 1000x. Level 3 means more candidates per load to filter, but a distance check costs well under a microsecond, so a few thousand candidates take about a millisecond. The load test picks the final value.

**Why not a database query.** The classic slow pattern is `WHERE lat BETWEEN … AND lon BETWEEN …` with separate B-tree indexes on `lat` and `lon`: each index returns a whole band of the map, and the database intersects the bands. This design never runs that query:
1. The direction is reversed. Searches are stored regions and each load is a point, so the question is "which stored regions contain this point?" (like Elasticsearch's percolator).
2. Geohash turns 2D into one key, so the lookup is a single hash-map read.
3. The same trick is why B-trees *do* work for geo when the key is a space-filling-curve value (geohash, S2 cell id, Hilbert index): nearby places share a key prefix. Redis `GEOSEARCH` and S2-based systems work this way.

Alternatives at production scale: **S2** (covers a circle with a few mixed-size cells: fewer entries and fewer false candidates) or **H3** (hexagons with even areas). For ad-hoc "loads near X" screens, an R-tree (PostGIS GiST). That's a different query from the alert path.

**Per new load:**

```
for s in index.get(load.origin.cell.slice(0,3) + '|' + load.equipment):
  spec = specs.get(s)
  if haversine(load.origin, spec.origin) > spec.deadheadMi: skip
  if !destOk(load.dest, spec.dest): skip
  if load.rate == null ? !spec.includeNoRate : (spec.minRpm && load.rate / load.miles < spec.minRpm): skip
  if pickup not within spec.pickupWithinDays: skip
  if load.visibleTo.kind == 'user' && load.visibleTo.userId != spec.userId: skip      // entitlement
  matched[spec.userId].push(s)
for userId in matched:
  if alerted.addIfAbsent(userId + ':' + canonicalId):    // in-memory Set: first time this user hears of this load
     alertHeap.push(new Alert(...))
```

A hot load matching 5,000 users is 5,000 in-memory set checks, about a millisecond, with no round trips. For a gated posting, entitlement narrows the candidates to one user's searches; the fan-out problem is mostly about shared-feed loads. Partition key: `cell3`, so hot cells (Chicago, Dallas, Atlanta) can get their own worker when split.

### 6.8 Alert queue

- **While keeping up** (oldest alert < 10 s old): **oldest first** (FIFO). That minimizes worst-case latency.
- **When overloaded** (oldest alert ≥ 10 s): **freshest first**. Older loads are more likely already taken, so a fresh load is more valuable to deliver.
- **Always:** drop alerts older than the deadline (10 min) and count them in `alerts_dropped_stale_total`.

Implementation: two heaps on `postedAt` (min and max) over the same items, or one sorted structure that can pop from both ends.

### 6.9 Notifier

- Chats are spread over bots by `hash(chatId) % bots`.
- Before each send, take a token from the bot bucket (30/s) and the chat bucket (1/s). If the chat bucket is empty, hold that chat's alerts for 2 s and merge them into one digest (up to 5 loads).
- On `429`, wait `retry_after` and put the alert back. Delivery is at least once; the `(user, load)` set makes a repeat harmless.
- HTTP concurrency to Telegram: ~10 sockets per bot (30 msg/s × ~0.2 s ≈ 6 in flight).
- The `deliver` span records `postedAt → accepted by Telegram`. That is the headline latency.

### 6.10 Live mode (`live/`)

Live mode runs the whole pipeline above continuously instead of as a one-shot batch job, plus a UI: one process, 2 + N threads. DESIGN.md §3.0 has the overall diagram; this section is the detail the other components above don't cover.

**`live/world-worker.ts`** — the outside world on its own thread: the stream, boards-sim and telegram-sim (HTTP on 127.0.0.1:7001/7002, so the engine talks to them exactly as to real boards) and the answer key, which must see both loads being born and alerts being delivered. Messages in: `clock` (the new anchor after a speed change), `rate`, `burst`, `searches` (your searches changed: rebuild the answer key), `loadFacts` (the agent asks about one load). Messages out: `ready`, `stats` every second (world, boards, score, the thread's event-loop p99), `postings` every 250 ms, `alert` for your deliveries, `loadFacts` replies.

**`live/stream.ts`** — a world that never stops. It wraps `sim/world.ts`'s `createWorld(seed)` in a real-time loop: `tick()` samples a Poisson count of new loads for however much simulated time just passed (rate = `loadsPerDay × HOURLY[centralHour(now)] / HOURLY_SUM`, the same hourly curve the batch generator uses), creates them, and schedules every posting each one will ever get (`world.postingsFor`: first post, refreshes, reposts, cross-board copies, a co-broker) on a min-heap keyed by `posted_at`. Due postings are released into the same `BoardData` shape `boards-sim` serves from, indexed by `geohash(origin, 3)`, so `src/engine.ts` can't tell live mode's boards from the batch simulator's. `prune()` drops postings older than `KEEP_MS` (6 simulated hours) so memory doesn't grow forever. `burst(city, equip, count, windowMs)` adds many loads out of one market inside a short window — the UI's burst button.

**`live/score.ts`** — the live answer key, built incrementally instead of read from a finished `truth.ndjson`. `onLoad(t)` runs the same `specMatches` filters as the batch scorer (`src/match/filters.ts`) against every search indexed near the load's geohash cell, and records an `Expect` for each user whose searches should hear about it — skipping searches created after the load was posted, so a brand-new search doesn't retroactively expect old loads. `onDelivery(d, loadOf)` checks each delivery against its expectation: a match removes it and records latency; a delivery that arrives after its expectation was already swept into `missed` is reclassified as `late`; one that was never expected and whose user had an active search before the load was posted counts as `backfill` (the load was already on the board when the search was saved, so matching it on save is correct, not a false alert); anything else is `unexpected`; a repeat delivery to the same user for the same load counts as a `duplicate` and is otherwise ignored. `sweep(now)`, run every 5 s, declares anything still pending after `SETTLE_MS` (15 simulated minutes — the engine's own 10-minute alert deadline plus 5 minutes of slack) as `missed`, additionally flagging `missedOpen5Min` when the load stayed coverable for at least 5 minutes (so it really should have been caught, not just a load that vanished almost immediately). `rebuild()` re-indexes searches by cell whenever they change and drops pending expectations for searches that no longer exist, counting those as `cancelled` rather than `missed`.

**`live/server.ts` API** (every path under `/api/`, alongside the built `ui/` served as static files):

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/metrics` | Prometheus scrapes this (job `load-radar-live`, `live:8080`): the SLO 2 answer-key counters (`answer_key_settled_total`, `answer_key_other_total`, `answer_key_pending`), on their own registry, separate from the engine's own `/metrics` on port 9464 |
| `GET` | `/api/state` | one-shot snapshot: stats, your saved searches, recent postings and alerts |
| `GET` | `/api/events` | Server-Sent Events: a `stats` event every second, a `postings` event every 250 ms (last 12), an `alert` event as each one is delivered |
| `POST` | `/api/parse` | runs the search parser (hybrid: rules, then GLiNER2 for whatever's still missing) and returns the parsed fields, the dispatcher-facing questions, and a `requestTraceId` so the UI can link to the trace |
| `POST` | `/api/searches` | parses the text, validates it (needs at least an origin and an equipment type), saves it, persists it to the `live_state` volume, and calls `engine.refreshSearches()` |
| `DELETE` | `/api/searches/:id` | removes the search, persists, and calls `engine.refreshSearches()` |
| `POST` | `/api/speed` | sets the clock's speed, clamped to 1–120× |
| `POST` | `/api/rate` | sets `loadsPerDay`, clamped to 1,000–500,000 |
| `POST` | `/api/burst` | asks the world thread for a burst, clamped to 5,000 loads |
| `POST` | `/api/agent` | "Should I take it?" for one alerted load: asks the world thread for the load and the lane's market rate, builds your truck from your nearest saved search of that equipment, runs the load-decision agent (`src/agent/`, mode and model from `--agent-mode` / `--agent-model`), and returns its decision next to the written policy's answer, with latency, tokens and the trace id |

Every path except `/api/events` and `/api/state` runs inside one OpenTelemetry trace (`SpanKind.SERVER`); path parameters like `/api/searches/Y12` are normalized to `/api/searches/:id` in the span name so traces group by route, not by every individual search id.

**`engine.refreshSearches()` and alert cancellation.** Called after any change to live mode's users or searches (a save or a delete). It rebuilds the matcher (`buildMatcher`) and every login's polling plan from the current `users` array — the same rebuild the batch engine does every 10 minutes on a timer, just triggered immediately instead. It then removes any alert still queued or held whose searches are *all* gone (`alertQueue.removeWhere(gone) + notifier.removeWhere(gone)`; one alert can serve several searches, so it's kept if even one is still active). `live/score.ts`'s own `rebuild()` does the matching cleanup on the answer-key side, so deleting a search doesn't just stop new alerts for it — it also stops counting alerts already in flight for it as upcoming misses.

**Adjustable clock** (`src/shared/clock.ts`, `createAdjustableClock`). The batch engine's `createSimClock` fixes `speed` once at start; live mode needs the UI's speed slider to change it mid-run without `now()` jumping. `createAdjustableClock` re-anchors `simAnchor` and `realAnchor` to the current `now()` every time `setSpeed()` is called, so time stays continuous across the change. Its `sleep()` also caps the real-time wait at 1 s regardless of the requested simulated duration, so a sleeping stage notices a speed change within a second instead of oversleeping at the old speed.

**Logger** (`src/obs/log.ts`). One function, `log(level, event, attrs)`, used everywhere instead of a logging framework. Each call does two things: prints one JSON line to stdout (`ts`, `level`, `event`, the attrs, and `trace_id`/`span_id` if a span is active on the current context), and — when an OTLP endpoint is configured — emits the same record through an OpenTelemetry `LoggerProvider`/`BatchLogRecordProcessor` to the collector, which forwards it to Loki. Carrying the trace id on every line is what lets Grafana jump from a log line straight to its trace (OBSERVABILITY.md's "slow alert → trace → logs" walkthrough). Events emitted today: `live.started`, `search.parsed`, `search.saved`, `search.removed` (with `alerts_cancelled`), `alert.sent`, `control.speed` / `control.volume` / `control.burst`, `parse.model_unavailable`, `api.error`.

## 7. Snapshots and recovery

**Design, not built yet.** The current engine keeps all hot-path state (section 3) only in memory, with no snapshot file, so a crash loses everything since the process started, not just a few seconds. What's described below is the fix:

- Every 5 s, write the snapshot-able state from section 3 (alerted keys, dedup buckets, canonical loads, cursors, budgets, heat) to `state/snapshot-<ts>.bin`, then atomically rename it to `state/snapshot.bin`. Hourly buckets mean only changed buckets need writing.
- On start: load searches and credentials (from their store, section 3), rebuild plans and the matcher index, load the snapshot, then begin polling. Budgets missing from the snapshot start at half budget to be safe with the boards.
- **Accepted loss on crash:** anything since the last snapshot (≤ 5 s) and the in-flight alert heap. Effects: a few missed alerts (loads seen but not yet delivered) and possibly duplicate alerts (deliveries after the last snapshot). The scorer measures both in a kill-and-restart test. If that loss is too high, it's a trigger for section 12.
- Today, live mode gets a weaker version of this for free: saved searches are the only state that matters across a restart, and those already live in the `live_state` volume (`live/server.ts`'s `you.json`), not in memory. Everything else (dedup state, alerted keys, in-flight alerts) is rebuilt from nothing on restart, which is fine for a demo but would miss and duplicate alerts right after a restart in production.

## 8. Guarantees and backpressure

- **Within one run: exactly-once processing** in memory, with no network hops between stages.
- **Across a crash: best effort**, bounded by the snapshot interval (section 7).
- **Repeats are absorbed** by the dedup `seen` map and the `alerted` set.
- **Backpressure:** bounded queues make producers wait (section 4). Notifier lag flips the alert order (section 6.8); poller lag stretches scheduler intervals (section 6.3). No queue grows without limit, and a full queue is a metric, never a silent drop.

## 9. Upstream: pools and N+1 (what bites first now)

With no shared store, the remaining "network" is the boards and Telegram. That's where pool limits and N+1 live.

**N+1 to board APIs.** Many real board APIs return a summary list, and a naive client then fetches each load's detail page. That's one extra request **per load**, spent from the customer's budget and adding latency:

| Where | N+1 version | Fixed version |
| --- | --- | --- |
| Poll results | 1 list request + 1 detail request per load (50 loads → 51 requests, 51× the budget) | one list request; everything needed for matching comes from the list. Fetch details only when a user opens an alert |
| Searches → requests | one request per saved search per board | merge into one query per login (section 6.2) |
| Planner reads | one SQLite query per search | one query per user (or one for everyone at start) |

**Connection pools, sized by Little's law** (`in-flight = request rate × response time`):

| Pool | Example load | Size needed | What happens if too small |
| --- | --- | --- | --- |
| Engine → each board | 2,000 req/s to DAT × 0.3 s = **600 in flight** | ~600 sockets (+30% headroom) | A fixed 64 caps throughput at ~210 req/s. Requests wait *inside the HTTP client*: board latency looks fine, our data gets staler, and nothing errors. The most likely silent limit in this system |
| Engine → Telegram | 30 msg/s × 0.2 s ≈ 6 per bot | ~10 per bot | Same queuing failure, smaller |
| Engine → SQLite | cold path only | one connection | — |

Each pool exposes its wait time (section 10). **A rising `http_pool_wait_seconds` with flat board latency means the pool is too small.**

One machine also has limits on open sockets and outbound ports: about 600 sockets per busy board is fine, but at 100× it becomes tens of thousands. That's one of the triggers in section 12.

## 10. Observability

This section lists what the code emits. [OBSERVABILITY.md](OBSERVABILITY.md) is the full plan: how latency is broken into parts, RED/USE, sampling, dashboards, alerts, runbooks and the load-test protocol.

### 10.1 Traces
One trace per posting; trace context travels with each item through the in-memory queues.

| Span | Attributes |
| --- | --- |
| `poll` | `board`, `entry_heat`, `status`, `postings_returned`, `pool_wait_ms` |
| `normalize` | `board`, `adapter_result` (ok, unknown place, unknown equipment) |
| `dedup` | `stage` (1 or 2), `result` (refresh, updated, merged, new), `candidates`, `score` |
| `match` | `candidates`, `matched_users` |
| `deliver` | `queue_mode` (fifo or fresh), `wait_ms`, `digest_size`, `post_to_alert_ms` |

### 10.2 Metrics
Labels stay low-cardinality: **never label by user or credential**, which would mean millions of series at 1000x. Per-credential detail goes into logs and traces.

```
post_to_alert_seconds{lane_heat}            histogram   SLO (built, see SLO.md): 99% of alerts within 60 s
upstream_requests_total{board,status}       counter
login_paused_total{board}, login_banned_total{board}   counter   SLO: banned = 0
poll_freshness_seconds{lane_heat}           histogram   age of the newest data per entry
http_pool_wait_seconds{board}               histogram   undersized pool shows up here first
http_sockets_in_use{board}                  gauge
stage_queue_depth{stage}, stage_queue_wait_seconds{stage}   gauge / histogram
nodejs_eventloop_lag_seconds                gauge       one busy stage delays all of them
heap_used_bytes, gc_pause_seconds           gauge / histogram   large in-memory state slows GC
snapshot_duration_seconds, snapshot_bytes   histogram / gauge
dedup_total{stage,result}                   counter
match_fanout                                histogram   candidates per load
alert_queue_depth, alert_queue_oldest_seconds  gauge
alerts_dropped_stale_total                  counter
normalize_unknown_place_total{board}, normalize_unknown_equipment_total{board}  counter
llm_calls_total{result}, llm_latency_seconds, llm_tokens_total{kind}            parser only
```

### 10.3 LLM call log
One record per call: `{ts, model, prompt, output, input_tokens, output_tokens, latency_ms, cost_usd, valid, fields_changed_by_user}`. Stored as an OTel span (GenAI conventions) and as JSONL. `fields_changed_by_user` comes from the confirmation step and is the real-world accuracy signal.

### 10.4 Dashboard (one Grafana board)
Row 1, customer view: post-to-alert p50/p95/p99, missed matches and duplicates (from the scorer), bans. Row 2, sources: requests by status per board, pool wait, paused logins, freshness. Row 3, engine: queue depth and wait per stage, event-loop lag, heap and GC, dedup results, fan-out. Row 4, delivery: alert queue depth and age, queue mode, stale drops, Telegram 429s.

**Built, and smaller than the above:** `ops/grafana/dashboards/load-radar.json`, provisioned as code and set as the server's home dashboard — an SLO row (SLO.md), then throughput, latency, health, model calls, and a table of recent requests linked to their traces and logs. OBSERVABILITY.md §10 has the full panel list and the parts of this row-by-row plan that aren't built yet.

## 11. Capacity: what breaks first on one machine

Work per unit, so measurements become capacity numbers:

| Unit | Main cost | Expected limit to measure |
| --- | --- | --- |
| One poll | an HTTPS request + parsing its JSON response | sockets (section 9), then CPU for TLS and JSON |
| One posting | normalize + dedup stage 1, all in memory (tens of µs) | CPU: roughly tens of thousands per second per core |
| One new canonical load | classifier on a few candidates + matcher candidates | CPU, spikes on hot cells |
| One alert | a set check + a heap push, then Telegram | Telegram's 30 msg/s per bot |

Likely order of failure on one machine, to confirm by measurement:
1. **Board budgets** (outside our control): the customer-facing limit.
2. **HTTP pool** if undersized: silent staleness (section 9).
3. **One CPU core** (event-loop lag rises): parsing board responses. Fix: worker threads by `credentialId`.
4. **Telegram delivery** on hot loads: digests, more bots, push.
5. **Heap and GC** as in-memory state grows: compact entries, partition.
6. **One machine's sockets, memory or CPU** in total: section 12.

## 12. When to add a shared store or log (triggers)

Add something only when a measurement shows the need:

| Trigger (measured) | Add | Not Redis because / when Redis fits |
| --- | --- | --- |
| One machine's CPU, memory or sockets run out after worker threads | **More machines, each owning partitions** (scheduler and pollers by `credentialId`, dedup by block key, matcher by `cell3`, alerts by `userId`), connected by a **log (Kafka or Redpanda)** | A log keeps "one owner per key" and replays state after a crash. A central Redis would bring back a network call per message and hot keys (Chicago vans on one core) |
| Crash loss from section 7 is too high | Durable log between stages; snapshots plus log replay | Same as above |
| Something can't be partitioned, e.g. a limit shared by many processes that don't own the key | A small shared store for that one thing. **Redis is a good fit here** (a token bucket in one Lua script) | Keep it off the per-posting path |
| Many API servers need shared sessions or caching | Redis as a cache **for the API only** | The hot path still doesn't touch it |

## 13. From demo to production

| Demo | Production at 1000x |
| --- | --- |
| One engine process (then worker threads) | Many engine processes, each owning partitions by the keys above |
| In-memory queues between stages | Kafka/Redpanda topics partitioned by the same keys |
| Snapshot file | Snapshots + log replay per partition |
| SQLite for searches and credentials | Postgres (cold path, small pool + PgBouncer); encrypted secrets in a KMS-backed vault |
| Telegram only | In-app push as the main channel; Telegram and SMS as extras |
| Per-login polling only | Partner and push feeds (the shared lane) for as much volume as possible. The biggest lever |

## 14. Security

- Board secrets are encrypted at rest (demo: libsodium sealed box with a local key; production: envelope encryption, keys in a KMS). They're decrypted only for the request, kept in memory, and never logged or put in traces.
- Every query and alert is scoped by `userId`; entitlement is enforced in the matcher, not the UI.
- Audit log of every credential use (credential id, board, time, status). This is also the evidence if a board ever questions an account's traffic.

## 15. Verification (no automated test suite)

Decision (2026-11-04): the project keeps **no automated unit or integration tests**. Correctness is checked by measuring the running system instead:

| What | How |
| --- | --- |
| End to end: misses, duplicates, latency, bans | `node scripts/run.ts` + the scorer against the answer key (`RUN_RESULT`) |
| Realism of the generated data | `node sim/validate.ts` against real reference numbers |
| Dedup classifier quality | held-out precision/recall in `ml/dedup/RESULTS.md`, plus a rule-vs-model end-to-end run |
| Search parser quality | the labeled eval set and `ml/parser/RESULTS.md` |
| Observability cost | `bench/overhead/` on a pinned Linux core |
| Scaling | the load-test runs in DESIGN.md → `SCALING.md` |

Trade-off: a regression is noticed when a scored run or an eval gets worse, not at the moment the code changes. The scorer is what caught the Day 1 entitlement bug (misses 68% → 3.6% after the fix).

**Scorer:** for each `(user, load)` that the answer key says should alert, given the user's searches, the load's true attributes and the user's credentials, it finds the first delivery. It reports latency (delivery time minus the load's first posting on a board that user has a login for; a co-broker repost on another board ~10 min later can't be alerted sooner), misses, duplicates and stale alerts. Expected matches use the same filters as the matcher, in a plain cell-indexed implementation that's easy to check by hand. It avoids comparing every load with every search (2 billion pairs at 100K × 20K).

## 16. Repo layout

This is the actual current layout; `SCALING.md` is the one piece from the original plan not written yet:

```
load-radar/
  README.md  DESIGN.md  LLD.md  OBSERVABILITY.md  DEPLOY.md  SCALING.md (after load tests, not written)
  docker-compose.yml          live mode, models (GLiNER2, Ollama), observability, Langfuse; app runs on demand
  ops/            server/deploy.sh, macos/*.plist (SSH tunnel), otel-collector.yaml, tempo.yaml, prometheus.yml, grafana/
  sim/            world.ts (the calibrated model), gen.ts (batch wrapper), validate.ts, data/, ASSUMPTIONS.md
  sims/           boards-sim.ts, telegram-sim.ts, cover.ts
  src/
    shared/       types.ts, queue.ts (bounded), heap.ts, expiring.ts (hourly eviction), clock.ts, geo.ts
    normalize/    gazetteer.ts, normalize.ts
    dedup/        dedup.ts (two stages, pluggable decision), features.ts (18 pair features, shared with training), classifier.ts (logistic scoring + parity check)
    match/        matcher.ts, filters.ts
    plan/         heat.ts, planner.ts
    schedule/     scheduler.ts
    poll/         poller.ts
    alerts/       alert-queue.ts, notifier.ts
    parse/        the search parser: rules, GLiNER2/Qwen extractors, normalizer (section 6.1)
    obs/          obs.ts (engine metrics + sampled traces), llm.ts (GenAI spans), log.ts (structured logs)
    engine.ts     wires the stages together; used by both batch mode and live mode
  live/           server.ts (API + UI host), stream.ts, score.ts, Dockerfile
  ui/             the React + shadcn/ui frontend (Vite build, served by live/server.ts)
  scorer/         score.ts (batch)
  bench/overhead/ the observability-cost benchmark, RESULTS.md
  ml/parser/      GLiNER2 service, eval harness, RESULTS.md
```
