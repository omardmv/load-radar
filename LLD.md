# Load Radar: low-level design

> New to the project? Start with [GUIDE.md](GUIDE.md) (Parts 3 and 5 cover this document in plain language).

[DESIGN.md](DESIGN.md) is the high-level design: the problem, the constraints, the parts and why they exist. This is the low-level design: data types, state, APIs, algorithms, failure handling and verification — detailed enough to build from. It targets the demo (Node/TypeScript), running continuously on a server ([DEPLOY.md](DEPLOY.md)); section 13 says what changes in production. It follows DESIGN.md's guiding rule: no shared store on the hot path — each stage keeps its state in memory, owned by exactly one worker and partitioned by key (a lookup costs ~0.1 µs instead of a ~100–200 µs network round trip). A store or log is added only when a measurement asks for it (section 12).

## 1. Processes

| Process | What runs inside | Talks to |
| --- | --- | --- |
| `engine` | api, planner, scheduler, pollers, normalizer, dedup, matcher, alert queue, notifier, as in-memory-queue modules | boards-sim and the alert channel sim over HTTP; searches/credentials from a flat file or passed in by live mode; no snapshot yet (section 7 is the design, not built) |
| `boards-sim` | replays `out/postings.ndjson` with budgets, 429s, bans, covered loads | — |
| alert channel sim (`sims/telegram-sim.ts`) | enforces delivery limits per sender and per dispatcher, logs deliveries | — |
| `scorer` | offline, compares deliveries with the answer key | files |
| `live` | one process, two threads: **world thread** (`live/world-worker.ts`: boards-sim + alert channel sim on 127.0.0.1:7001/7002, the rolling answer key); **main thread** (`live/server.ts`: one engine on its main thread — api, planner, scheduler, pollers, normalizer, dedup, matcher, alert queue, notifier — plus the UI's HTTP+SSE API, search parser, agent) | threads exchange messages; the engine reaches the simulators over HTTP; outside the container: GLiNER2, Ollama, the collector, the browser; searches persist in `live_state` |
| `cluster-world` (`cluster/world.ts`) | the engine cluster's outside world: boards-sim and the alert channel sim (:7001/:7002), dispatcher registration for the answer key (:7003), answer-key metrics (:9464) | engine replicas reach it over HTTP; `dispatchers` registers through it |
| `engine` replicas (`cluster/engine.ts`), `--scale engine=N`, one core each | starts owning nothing; owns whichever dispatchers `engine-lb` routes to it and polls the boards only for those. API: `PUT /api/dispatchers/:id`, `GET /api/dispatchers/:id/alerts` | `cluster-world` over HTTP; sits behind `engine-lb` |
| `engine-lb` (`cluster/nginx.conf` + `upstreams.conf`) | nginx; consistent hash on the dispatcher id so one dispatcher always reaches the same engine | `engine` replicas |
| `dispatchers` (`cluster/dispatchers.ts`) | plays N dispatchers (default 6000): registers them with the answer key, saves searches through `engine-lb`, checks alerts every ~30 s, re-saves every ~10 min | `cluster-world` (registration), `engine-lb` (API) |

Infrastructure in `docker compose` ([DEPLOY.md](DEPLOY.md)): OTel Collector, Tempo, Loki, Prometheus, Grafana, GLiNER2, Ollama, self-hosted Langfuse, and `live` — all running continuously. `app` and `cluster` profiles run on demand.

## 2. Data model (TypeScript types)

```ts
type Equip = 'van' | 'reefer' | 'flatbed';
type Board = 'dat' | 'truckstop' | 'portal_a' | 'portal_b' | 'shared';

// A user's saved search, after parsing and confirmation.
interface SearchSpec {
  searchId: string; userId: string; origin: { lat: number; lon: number; label: string };
  deadheadMi: number;                                // 25..300
  dest: { kind: 'anywhere' } | { kind: 'states'; states: string[] } | { kind: 'point'; lat: number; lon: number; radiusMi: number };
  equipment: Equip[]; minRpm: number | null; includeNoRate: boolean;  // includeNoRate default true: "no rate, call to negotiate"
  pickupWithinDays: number; boards: Board[]; createdAt: number; version: number;  // pickupWithinDays 0..7; boards = which logins
}
// One customer login on one board. The secret is stored encrypted and never logged.
interface Credential {
  credentialId: string; userId: string; board: Board; status: 'active' | 'paused' | 'banned';
  budgetPerMin: number; pausedUntil: number | null; consecutive429: number;        // budgetPerMin: board-specific req/min
}
// One query the scheduler runs repeatedly: one login, one merged board query.
interface PlanEntry {
  entryId: string; credentialId: string; userId: string; board: Board;
  query: { lat: number; lon: number; radiusMi: number; equipment: Equip[]; pickupFrom: string; pickupTo: string };
  searchIds: string[];                               // the searches this entry serves
  heat: number; intervalMs: number;                  // heat: new matching postings/min (EWMA); intervalMs: section 6.3
  nextAt: number; cursor: number;                    // next run time; newest postedAt seen (poll asks only for newer)
}
// What a poller hands to the normalizer: untouched board JSON plus where it came from.
interface RawPosting {
  board: Board; credentialId: string | null; userId: string | null; entryId: string | null; fetchedAt: number; raw: unknown;  // credentialId null for shared feeds
}
// The one schema everything after the normalizer uses.
interface Load {
  key: string;                                       // `${board}:${boardLoadId}`
  board: Board; boardLoadId: string; brokerMc: string; brokerName: string;
  origin: { lat: number; lon: number; city: string; state: string; cell: string };  // cell = geohash level 4 (~29×20 km): dedup blocks
  dest:   { lat: number; lon: number; city: string; state: string; cell: string };  // matcher uses level 3 = cell.slice(0, 3)
  equipment: Equip; equipmentDetail: string; rate: number | null; miles: number; weightLbs: number | null;
  pickupDate: string;                                // YYYY-MM-DD, US Central
  postedAt: number;                                  // the board's timestamp: the start of the latency clock
  comments: string;
  visibleTo: { kind: 'all' } | { kind: 'user'; userId: string; credentialId: string };
  contentHash: string; canonicalId?: string;         // canonicalId set by dedup
}
interface Alert {
  alertId: string; userId: string; canonicalId: string; searchIds: string[];
  summary: string;                                   // "Chicago, IL → Atlanta, GA · Van · $1,950 · 716 mi · pickup today"
  postedAt: number; enqueuedAt: number; deadline: number;
}
```

## 3. State: where everything lives

Hot-path state is in memory. Each piece has exactly one owner, so there's no locking and no shared store.

| State | Structure | Size at demo scale | Eviction | Owner, partition key | Survives restart via |
| --- | --- | --- | --- | --- | --- |
| Searches, credentials (source of truth) | **Design: SQLite. Built: a flat file** — `searches.ndjson` (batch) or one JSON file per live user (`live_state`) | ~20K + ~8K rows | none | api; cold path | the file itself; a real deployment uses a database (section 13) |
| Plan entries + schedule | `Map<entryId, PlanEntry>` + **min-heap** on `nextAt` | ~10K | rebuilt on search change | scheduler, `credentialId` | rebuilt from searches |
| Login budgets | `Map<credentialId, TokenBucket>` | ~8K | none | scheduler, `credentialId` | snapshot (else half budget) |
| Dedup "seen" | `Map<board:id, contentHash>` in **hourly buckets** | ~300K | drop oldest bucket after 72 h | dedup, block key | snapshot |
| Dedup candidate blocks | `Map<blockKey, Entry[]>` (entries hold classifier features) | ~100K canonical loads | same hourly buckets | dedup, block key | snapshot |
| Canonical loads | `Map<canonicalId, Load>` | ~100K | 72 h | dedup | snapshot |
| Heat per cell | `Map<cell3|equip, EWMA>` | ~thousands | none | dedup → planner | snapshot |
| Matcher index + specs | `Map<cell3|equip, Set<searchId>>` + `Map<searchId, SearchSpec>` | ~20K specs × 6–20 cells | rebuilt on search change | matcher, `cell3` | rebuilt on start, and by `engine.refreshSearches()` |
| Alerted keys `(user, load)` | `Set<string>` in hourly buckets | ~100K | 72 h | matcher → alert stage, `userId` | snapshot (prevents repeat alerts after a restart) |
| Alert queue | binary heap on `postedAt` (pop min or max, section 6.8) | small | deadline drop | notifier | lost on crash (accepted, section 8) |
| Delivery buckets | token buckets per sender and per dispatcher | ~users | idle 1 h | notifier, `chatId` | not needed |

**Memory note:** keep entries compact (short string keys, numbers not objects), drop whole hourly buckets instead of deleting items one by one, and watch `heap_used_bytes` and GC pause time (section 10) — large heaps are one of the first things to break on a single machine (section 11).

## 4. Inside the engine: stages and queues

```
api ─▶ planner ─▶ scheduler ─▶ [poll queue] ─▶ pollers ─▶ [raw queue] ─▶ normalizer ─▶ [norm queue]
                                                                                            │
 web alerts ◀─ notifier ◀─ [alert heap] ◀─ matcher ◀─ [new-load queue] ◀─ dedup ◀──────────────┘
```

Every arrow is a **bounded** queue (ring buffer) with a length and wait-time metric; a full queue makes the producer `await` instead of piling up work, and each stage processes a batch per event-loop turn so a burst doesn't starve the others. **Overload rules on the poll path** (`src/engine.ts`): an entry still queued, waiting for its login, or running is never queued again (`polls_coalesced`), so the poll queue can't grow past the number of plan entries; and each login has at most **one request in flight** (`busyLogins`, `waitingForLogin`), so a 429 can pause a login before more requests reach the board.

## 5. APIs

**5.1 Public API (inside `engine`), production design — not built in this form.** What runs today is live mode's API (section 6.10). The shape: `POST /searches {text}` → a draft + confirmation (`"llm"` or `"rules"`), `POST /searches/{id}/confirm`, `GET`/`DELETE /searches`, `POST /credentials {board, username, secret}` → `{credentialId}` (secret stored encrypted), `GET /healthz`, `/metrics`.

**5.2 Board simulator (`boards-sim`): the contract pollers code against.**

```
GET /{board}/loads?lat=41.88&lon=-87.63&radius=100&equipment=van,reefer&pickup_from=2026-11-04&pickup_to=2026-11-06&since=1793772000000
X-Credential: dat-9dbe45b5
```

`200` + raw postings not yet "covered"; `429` + `Retry-After: s` over budget; `403 {"error":"account_suspended"}` after repeated abuse; `5xx`/slow for the board-outage test. Loads are removed once "covered" (lognormal ~20 min after posting, shorter on hot lanes); default budget 60/min; a login is banned after 20+ rejected requests in 10 min. Each list response has everything the pipeline needs — no per-load detail call (section 9).

**5.3 Alert channel simulator (`sims/telegram-sim.ts`).** `POST /bot{botId}/sendMessage {chat_id, text}` → `200`, or `429 {"parameters":{"retry_after":s}}` beyond 30 msg/s per sender or 1/s per dispatcher (the API shape is kept from the simulator's code: `/bot{id}` is a sender, `chat_id` a dispatcher). Every accepted message is logged with its receive time for the scorer.

## 6. Components in detail

**6.1 Search parser** (`src/parse/`; measured comparison: `ml/parser/RESULTS.md`). Cascade: rules (regex) extract spans; a model (GLiNER2, or Qwen via Ollama) fills in only equipment or origin the rules missed; one normalizer interprets spans into places, states, numbers and defaults, so all extractors are compared on equal terms. **Never guess silently:** an `unspecified` label plus a 0.6 confidence threshold turns an uncertain field (missing equipment, an ambiguous place like Kansas City MO/KS, a direction like "north") into a question instead of a guess. Defaults: destination anywhere, deadhead 100 mi, no rate floor, destination radius 150 mi. Every model call is a GenAI span (`src/obs/llm.ts`) to Langfuse, Tempo and Prometheus. Not supported yet: exclusions ("anywhere but NY"), multi-stop searches.

**6.2 Planner.** Runs when a user's searches change, and every 10 minutes to refresh heat; loads a user's searches and credentials with one query each, not one per search.

```
for each user, for each board the user has a credential for:
  S = the user's searches that use this board
  group S by equipment set
  for each group: greedy merge of origins:
     start with the search having the largest deadhead
     merge another search if one circle (center = weighted midpoint, radius = max distance + its deadhead) covers both, and radius <= 150 mi
  each merged group -> one PlanEntry (query covers the union; the matcher filters exactly afterwards)
```

**Heat** for an entry sums the heat EWMAs (α = 0.1/min) over the level-3 cells its circle covers, updated by dedup as loads arrive.

**6.3 Scheduler.** A credential's budget `B` requests/min is shared by its entries. Entry `i` gets new matching loads at rate `λᵢ`; polled `fᵢ` times/min, a load waits `1/(2fᵢ)` min on average. Minimizing `Σ λᵢ/(2fᵢ)` subject to `Σ fᵢ = B` gives:

```
fᵢ = B · √λᵢ / Σⱼ √λⱼ          then clamp each to [1/5 min, 12/min] (between every 5 min and every 5 s)
```

Busy lanes are polled more, but only in proportion to the square root of their rate, so quiet entries still get checked. `intervalMs = 60000 / fᵢ`, plus ±10% jitter. Main loop:

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

`stretch` is 1 normally and grows when the poll queue's oldest item waits more than 1 s. Reacting to board responses: `200` resets `consecutive429` to 0; `429` increments it and sets `pausedUntil = now + min(15 min, max(Retry-After, 2^n × 5 s))` with jitter; three `429`s in 10 minutes opens the circuit (pause 15 min, halve the budget for an hour); `403 account_suspended` bans the credential, stops every entry for it and notifies the user (SLO: always 0 bans).

**6.4 Pollers.** A pool of async tasks taking entries from the poll queue, concurrency per board capped by a semaphore sized with Little's law (section 9), matching the HTTP agent's socket count. Timeout 5 s, no retry inside the poller — the scheduler owns retry timing. `since = entry.cursor` so only new postings return; a success moves the cursor to the newest `postedAt`. One request per poll, never a follow-up call per load (section 9).

**6.5 Normalizer.** One adapter per board turns its JSON into the one `Load` schema (per-field differences: DESIGN.md §3.3). Equipment maps into `van`/`reefer`/`flatbed` (`VR`/Van-Reefer → `van`, with `equipmentDetail` kept so reefer searches can opt in); unknown values are dropped and counted. Place lookup (gazetteer, in memory): exact match on normalized city+state, then known aliases, then — because Truckstop's names are cut at 14 characters — a prefix match within the state, then Jaro-Winkler fuzzy match (≥ 0.92); anything else is dropped and counted. Then `cell = geohash(lat, lon, 4)` (matcher uses the first 3 characters), `contentHash = sha1(board, id, rate, pickupDate, origin, dest, equipment)`, and `visibleTo` comes from the `RawPosting`.

**6.6 Dedup.** Stage 1, exact (most postings stop here): `seen.get(board:id)` — same hash is a refresh (no emit); a different hash is an edit (update canonical, emit `updated`); no previous entry means it's new, so it goes to stage 2. Reposts with a new id, cross-posts, and co-broker copies all reach stage 2.

Stage 2, same-load classifier: logistic regression trained on answer-key pairs (features, threshold policy, results and limits in [ML.md](ML.md)). Candidates come from the block `(pickupDate, oCell, dCell, equip)` plus its 8 neighboring origin cells, within the last 6 hours; block entries carry pre-computed features (relative rate difference, either rate missing, same broker MC, name similarity, distance, posting-time gap, same board, weight difference, same `equipmentDetail`), so scoring needs no extra lookups. The threshold targets merge precision ≥ 99.5% on held-out data — a false merge hides a real load, which costs more than a false split's duplicate. A match joins the candidate's `canonicalId`; no match starts a new canonical load; either way the result goes to the new-load queue.

**Visibility is not merged:** each arrival carries its own `visibleTo`, so two users who each find the same load through their own logins are each alerted once; a shared-feed copy makes the canonical load visible to all. Partition key: `hash(pickupDate, oCell, equip)`.

**6.7 Matcher.** Index, rebuilt from the searches store at start and on every search change:

```
index: Map<`${cell3}|${equip}`, Set<searchId>>          // cell3 = geohash level 3, ~117 × 157 km near Chicago
specs: Map<searchId, SearchSpec>                        // full specs in memory: no lookup per candidate
a search is added to every level-3 cell whose rectangle comes within deadheadMi of its origin
```

That covering rule guarantees no misses. Level 3, not 4, trades more candidates per load for a smaller index — measured 6 cells at level 3 vs 99 at level 4 for a 75 mi Chicago search, and a distance check costs well under a microsecond. This never runs a lat/lon range query (DESIGN.md §4, decision 8): a load is a point, so geohash turns the 2D lookup into one hash read. Per new load:

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
  if alerted.addIfAbsent(userId + ':' + canonicalId): alertHeap.push(new Alert(...))  // first time this user hears of this load
```

A hot load matching 5,000 users costs 5,000 in-memory set checks, about a millisecond, no round trips. Partition key: `cell3`, so hot cells (Chicago, Dallas, Atlanta) can get their own worker when split.

**6.8 Alert queue.** Oldest first while keeping up (oldest alert < 10 s old, minimizing worst-case latency); freshest first once overloaded (an older load is more likely already taken); always drop alerts past the 10-minute deadline, counted in `engine_gauge{name="alerts_dropped_stale"}`. Implementation: two heaps on `postedAt` (min and max) over the same items, or one sorted structure that pops from both ends.

**6.9 Notifier.** Dispatchers are spread over senders by `hash(dispatcher) % senders`. Each send takes a token from the sender bucket (30/s) and the dispatcher bucket (1/s); if the dispatcher bucket is empty, the alert is held 2 s and merged into one digest (up to 5 loads). On `429`, wait `retry_after` and retry the send — delivery is at least once, and the `(user, load)` set makes a repeat harmless. HTTP concurrency to the alert channel: ~10 sockets per sender. The `deliver` span records `postedAt → accepted by the alert channel`: the headline latency.

**6.10 Live mode** (`live/`) runs the pipeline above continuously, plus a UI: one process, two threads, with the engine running on the main thread (full diagram: DESIGN.md §3.0).

**`live/world-worker.ts`** is the outside world on its own thread: the stream, boards-sim and the alert channel sim on 127.0.0.1:7001/7002 (the engine talks to them exactly as to real boards), and the rolling answer key, which sees both loads being born and alerts being delivered. **`live/stream.ts`** is a world that never stops: it samples a Poisson count of new loads per tick (rate = `loadsPerDay × HOURLY[centralHour(now)] / HOURLY_SUM`), schedules every posting each will ever get on a min-heap keyed by `posted_at`, and releases due ones into the same `BoardData` shape `boards-sim` serves from; it prunes postings older than 6 simulated hours, and `burst()` backs the UI's burst button. **`live/score.ts`** is the live answer key, built incrementally: `onLoad` records an `Expect` per user whose searches should hear about a new load; `onDelivery` checks each delivery against it (`late` if it arrives after the cutoff, `backfill` if the search predates the load, else `unexpected`, `duplicate` on a repeat); `sweep()` (every 5 s) declares anything pending past 15 simulated minutes `missed`; `rebuild()` re-indexes on search changes.

`live/server.ts`'s API (under `/api/`, alongside the built `ui/` served as static files): `GET /metrics` (the SLO answer-key counters, separate from the engine's own `/metrics` on :9464); `GET /api/state` / `/api/events` (one-shot snapshot; SSE — `stats`/s, `postings`/250ms, `alert` per delivery); `POST /api/parse` / `/api/searches` (run the parser; or parse + validate + save + persist + `engine.refreshSearches()`); `DELETE /api/searches/:id`; `POST /api/speed` (1–120×) / `/api/rate` (1K–500K loads/day) / `/api/burst` (≤5,000 loads); `POST /api/agent` ("Should I take it?": builds your truck from your nearest matching search, runs the load-decision agent, returns its verdict next to the written policy's). Every path but `/api/events`/`/api/state` runs in one OpenTelemetry trace, with `/api/searches/Y12` normalized to `/api/searches/:id` in the span name.

`engine.refreshSearches()` (called after any search change) rebuilds the matcher and polling plans, then cancels any queued or held alert whose searches are *all* gone. The **adjustable clock** (`createAdjustableClock`) re-anchors sim time to real time on every speed change, so the UI's slider doesn't make `now()` jump. The **logger** (`src/obs/log.ts`) is one `log(level, event, attrs)` function: one JSON line to stdout, plus the same record to the collector when OTLP is configured, carrying the active span's trace id.

**6.11 Engine cluster** (`cluster/`) scales the engine out behind nginx, run on demand ([DEPLOY.md](DEPLOY.md)). Each `engine` replica starts owning no dispatchers; `engine-lb` hashes the dispatcher id taken from the URL, so a dispatcher's calls always land on the same replica, which is the one that then owns and polls for it — one `server` line per replica (`cluster/upstreams.conf`), `max_fails=0` (so one failed request never moves a dispatcher elsewhere), 65 s keep-alive. A `PUT /api/dispatchers/:id` call saves that dispatcher's logins and searches; changes are applied every 5 s — one rebuild of the match index, and new polling plans only for the dispatchers that changed (`engine.refreshUsers()`), so a save that changes nothing does no work.

## 7. Snapshots and recovery

**Design, not built yet.** The engine keeps all hot-path state (section 3) only in memory, with no snapshot file, so a crash loses everything since the process started. The fix: every 5 s, write the snapshot-able state (alerted keys, dedup buckets, canonical loads, cursors, budgets, heat) to `state/snapshot-<ts>.bin`, then atomically rename it to `state/snapshot.bin` (hourly buckets mean only changed buckets need writing). On start: load searches and credentials, rebuild plans and the matcher index, load the snapshot, then begin polling (budgets missing from the snapshot start at half budget).

**Accepted loss on crash:** anything since the last snapshot (≤ 5 s) and the in-flight alert heap — a few missed alerts and possibly some duplicates, measured in a kill-and-restart test. Too much loss is a trigger for section 12. Today, live mode gets a weaker version of this for free: saved searches are the only state that matters across a restart, and those live in the `live_state` volume (`you.json`); everything else rebuilds from nothing — fine for a demo, but would miss and duplicate alerts right after a restart in production.

## 8. Guarantees and backpressure

Within one run: exactly-once processing in memory, no network hops between stages. Across a crash: best effort, bounded by the snapshot interval (section 7). Repeats are absorbed by the dedup `seen` map and the `alerted` set. Backpressure: bounded queues make producers wait (section 4); notifier lag flips the alert order (section 6.8); poller lag stretches scheduler intervals (section 6.3). No queue grows without limit, and a full queue is a metric, never a silent drop.

## 9. Upstream: pools and N+1 (what bites first now)

With no shared store, the remaining "network" is the boards and the alert channel. **N+1 to board APIs:** a naive client fetches one detail request per load on top of the list request — fixed by putting everything matching needs in the list response and fetching details only when a user opens an alert; likewise one query per saved search becomes one merged query per login (section 6.2), and one planner query per search becomes one per user.

**Connection pools, sized by Little's law** (`in-flight = request rate × response time`): engine → each board, e.g. 2,000 req/s × 0.3 s ≈ 600 sockets needed (+30% headroom) — too few and requests queue *inside the HTTP client*, so board latency looks fine while our data goes stale and nothing errors (the most likely silent limit here); engine → alert channel, ~10 sockets per sender; engine → SQLite, one connection (cold path only). Each pool exposes its wait time (section 10) — **a rising `http_pool_wait_seconds` with flat board latency means the pool is too small.**

## 10. Observability

This section lists what the code emits; [OBSERVABILITY.md](OBSERVABILITY.md) is the full plan (latency breakdown, RED/USE, sampling, dashboards, alerts, runbooks).

**Traces:** one per posting, trace context carried through the in-memory queues. Spans: `poll` (`board`, `entry_heat`, `status`, `postings_returned`, `pool_wait_ms`), `normalize`/`dedup`/`match` (adapter result; stage + result + candidates/score; candidates + matched_users), `deliver` (`queue_mode`, `wait_ms`, `digest_size`, `post_to_alert_ms`).

**Metrics** (Prometheus, never labeled by user or credential — millions of series at 1000x; per-credential detail goes into logs and traces instead): `post_to_alert_seconds{lane_heat}` (the speed SLO), `upstream_requests_total{board,status}`, `login_paused_total`/`login_banned_total` (SLO: banned = 0), `http_pool_wait_seconds{board}` (an undersized pool shows up here first), `stage_queue_depth{stage}`, `alert_queue_depth`/`alert_queue_oldest_seconds`, `dedup_total{stage,result}`, `match_fanout`. Full catalog: OBSERVABILITY.md §10.

**LLM call log:** one record per call — `{ts, model, prompt, output, input_tokens, output_tokens, latency_ms, cost_usd, valid, fields_changed_by_user}` — as an OTel span (GenAI conventions) and as JSONL; `fields_changed_by_user` is the real-world accuracy signal.

**Dashboard:** built and provisioned as code, `ops/grafana/dashboards/load-radar.json`, set as the server's home dashboard — an SLO row (SLO.md), then throughput, latency, health, model calls, and recent requests linked to their traces and logs.

## 11. Capacity: what breaks first on one machine

Measured results: DESIGN.md §5, SLO.md. Likely order of failure: **board budgets** (outside our control, the customer-facing limit) → **HTTP pool** if undersized (silent staleness, section 9) → **one CPU core**/event-loop lag from parsing board responses (fix: the engine cluster, section 6.11, partitioned by dispatcher id) → **alert delivery** on hot loads (digests, more senders, a second channel) → **heap and GC** as in-memory state grows (compact entries, partition) → the **machine's sockets, memory or CPU** in total (section 12).

## 12. When to add a shared store or log (triggers)

Add something only when a measurement shows the need:

| Trigger (measured) | Add | Not Redis because / when Redis fits |
| --- | --- | --- |
| One machine's CPU, memory or sockets run out after the engine cluster already fills it | **More machines**, each owning partitions (scheduler/pollers by `credentialId`, dedup by block key, matcher by `cell3`, alerts by `userId`), connected by a **log** (Kafka/Redpanda) | A log keeps "one owner per key" and replays state after a crash; a central Redis brings back a network call per message and hot keys |
| Crash loss from section 7 is too high | Durable log between stages; snapshots plus log replay | Same as above |
| Something can't be partitioned (a limit shared by processes that don't own the key), or many API servers need shared sessions/caching | A small shared store for just that thing — **Redis fits here** (a token bucket in one Lua script; a cache for the API) | Kept off the per-posting path; the hot path still doesn't touch it |

## 13. From demo to production

| Demo | Production at 1000x |
| --- | --- |
| One engine process, in-memory queues between stages | Many engine processes, each owning partitions by the keys above; Kafka/Redpanda topics by the same keys |
| Snapshot file; SQLite for searches and credentials | Snapshots + log replay per partition; Postgres (small pool + PgBouncer); secrets in a KMS-backed vault |
| One web channel | Web (in-app) as the main channel; mobile push and SMS as extras |
| Per-login polling only | Partner and push feeds (the shared lane) for as much volume as possible — the biggest lever |

## 14. Security

Board secrets are encrypted at rest (demo: libsodium sealed box with a local key; production: envelope encryption, keys in a KMS), decrypted only for the request, kept in memory, never logged or traced. Every query and alert is scoped by `userId`; entitlement is enforced in the matcher, not the UI. An audit log records every credential use (credential id, board, time, status) — also the evidence if a board ever questions an account's traffic.

## 15. Verification

No automated unit or integration tests. Correctness is checked by measuring the running system:

| What | How |
| --- | --- |
| End to end: misses, duplicates, latency, bans | `node scripts/run.ts` + the batch scorer, or `live/score.ts` plus SLO.md's dashboards for the always-on system |
| Engine cluster scaling (1–N engines, hash vs round robin) | `scripts/cluster-steps.sh`, read against Prometheus |
| Realism of the generated data | `node sim/validate.ts` against real reference numbers |
| Dedup classifier quality | held-out precision/recall in `ml/dedup/RESULTS.md` |
| Search parser quality | the labeled eval set and `ml/parser/RESULTS.md` |
| Observability cost | `bench/overhead/` on a pinned Linux core |

**Scorer:** for each `(user, load)` the answer key says should alert, it finds the first delivery and reports latency, misses, duplicates and stale alerts, using the same filters as the matcher. A regression shows up as a worse scored run, eval, or SLO burn rate — not at the moment the code changes.

## 16. Repo layout

```
load-radar/
  README.md  DESIGN.md  LLD.md  OBSERVABILITY.md  DEPLOY.md  SCALING.md (after load tests, not written)
  docker-compose.yml   live mode, models, observability, Langfuse; app and cluster profiles run on demand
  ops/            server/deploy.sh, macos/*.plist (SSH tunnel), otel-collector.yaml, tempo.yaml, prometheus.yml, grafana/
  sim/            world.ts (calibrated model), gen.ts (batch wrapper), validate.ts, data/, ASSUMPTIONS.md
  sims/           boards-sim.ts, telegram-sim.ts (alert channel), cover.ts
  src/            shared/ (types, bounded queue, heap, hourly-eviction set, clock, geo); normalize/ (gazetteer, normalize);
                  dedup/ (two-stage dedup, 18 pair features, classifier); match/ (matcher, filters); plan/ (heat, planner);
                  schedule/ (scheduler); poll/ (poller); alerts/ (alert-queue, notifier); parse/ (rules, GLiNER2/Qwen, normalizer);
                  obs/ (metrics + sampled traces, GenAI spans, structured logs); engine.ts (wires it all together)
  live/           server.ts (API + UI host), world-worker.ts, stream.ts, score.ts, Dockerfile
  cluster/        world.ts (cluster-world), engine.ts (engine replicas), nginx.conf + upstreams.conf (engine-lb), dispatchers.ts
  ui/             the React + shadcn/ui frontend (Vite build, served by live/server.ts)
  scorer/         score.ts (batch)
  scripts/        run.ts (batch run), cluster-steps.sh (engine cluster scale test)
  bench/overhead/ the observability-cost benchmark, RESULTS.md
  ml/parser/      GLiNER2 service, eval harness, RESULTS.md
```
