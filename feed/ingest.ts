// Push-feed ingest worker: partners POST each new posting to us (one webhook per posting) instead of us polling.
// Several of these run behind nginx (feed/nginx.conf). Each is stateless toward the others but keeps dedup and
// "already alerted" state in its own memory, so WHICH worker gets a posting matters: every copy of one load must land
// on the same worker, or two workers each think it's new and the dispatcher is alerted twice.
//
// Shared feeds are visible to every customer (no per-login entitlement), so each worker holds the full search index
// (read-only, the same synthetic dispatchers in every worker) and matches against all of them.
//
//   node feed/ingest.ts --port 7200 --metrics-port 9464 --sink http://feed-sink:7300 --users 200
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import client from 'prom-client';
import type { Clock } from '../src/shared/clock.ts';
import { createExpiringSet } from '../src/shared/expiring.ts';
import { toUser } from '../src/data/users.ts';
import { loadGazetteer } from '../src/normalize/gazetteer.ts';
import { createNormalizer } from '../src/normalize/normalize.ts';
import { createDedup } from '../src/dedup/dedup.ts';
import { loadClassifier } from '../src/dedup/classifier.ts';
import { buildMatcher } from '../src/match/matcher.ts';
import { createWorld } from '../sim/world.ts';
import type { Board } from '../src/shared/types.ts';

const { values: a } = parseArgs({ options: {
  port: { type: 'string', default: '7200' }, 'metrics-port': { type: 'string', default: '9464' }, sink: { type: 'string', default: 'http://127.0.0.1:7300' },
  users: { type: 'string', default: '200' }, 'users-seed': { type: 'string', default: '7' }, 'dedup-model': { type: 'string', default: 'ml/dedup/model.json' } } });
const here = dirname(fileURLToPath(import.meta.url));
const worker = hostname();

// Feed time: the latest posted_at seen. The generator compresses hours of postings into minutes, so state expires on
// the feed's own timeline (72 h of postings), not the wall clock, and memory stays bounded during a long run.
let feedNow = 0;
const clock: Clock = { now: () => feedNow, speed: 1, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const world = createWorld(Number(a['users-seed']));
const users = Array.from({ length: Number(a.users) }, (_, i) => toUser(world.makeUser(i + 1)));
const matcher = buildMatcher(users.flatMap((u) => u.searches));
const normalize = createNormalizer(loadGazetteer(join(here, '../sim/data')));
const dedup = createDedup(clock, a['dedup-model'] ? loadClassifier(a['dedup-model']).sameLoad : undefined);
const alerted = createExpiringSet(72 * 3_600_000, 3_600_000, clock);        // one alert per (user, load) on this worker

const reg = new client.Registry();
client.collectDefaultMetrics({ register: reg });
const reqs = new client.Counter({ name: 'feed_ingest_requests_total', help: 'postings received', labelNames: ['result'], registers: [reg] });
const dedupC = new client.Counter({ name: 'feed_dedup_total', help: 'dedup results', labelNames: ['result'], registers: [reg] });
const alertsC = new client.Counter({ name: 'feed_alerts_emitted_total', help: 'alerts sent to the sink', registers: [reg] });
const handleSec = new client.Histogram({ name: 'feed_ingest_seconds', help: 'time to handle one posting (normalize, dedup, match)', registers: [reg], buckets: [0.00001, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.01] });
reqs.inc({ result: 'ok' }, 0); reqs.inc({ result: 'bad' }, 0);
createServer(async (req, res) => { res.writeHead(200, { 'content-type': reg.contentType }); res.end(await reg.metrics()); }).listen(Number(a['metrics-port']), '0.0.0.0');

// Alerts go to the sink in batches every 250 ms (it scores latency and duplicates against the generator's truth).
type Out = { user: string; load: string; sentAt: number; worker: string };
let batch: Out[] = [];
setInterval(() => {
  if (!batch.length) return;
  const body = JSON.stringify(batch); batch = [];
  fetch(`${a.sink}/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.arrayBuffer()).catch(() => {});
}, 250);

type Push = { board: Board; raw: unknown; load_id: string; sent_at: number };
createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/loads') { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const t0 = performance.now();
    let p: Push;
    try { p = JSON.parse(Buffer.concat(chunks).toString()); } catch { reqs.inc({ result: 'bad' }); res.writeHead(400); res.end(); return; }
    const n = normalize({ board: p.board, credentialId: null, userId: null, entryId: null, fetchedAt: Date.now(), raw: p.raw });
    if (n.ok) {
      const load = n.load;
      if (load.postedAt > feedNow) feedNow = load.postedAt;
      const d = dedup(load);
      dedupC.inc({ result: d.result });
      for (const [user] of matcher.match(load).users) {
        const k = `${user}|${load.canonicalId}`;
        if (alerted.has(k)) continue;
        alerted.add(k);
        batch.push({ user, load: p.load_id, sentAt: p.sent_at, worker });
        alertsC.inc();
      }
    }
    handleSec.observe((performance.now() - t0) / 1000);
    reqs.inc({ result: n.ok ? 'ok' : 'bad' });
    res.writeHead(202); res.end();
  });
}).listen(Number(a.port), '0.0.0.0', () => console.log(`ingest ${worker} on :${a.port}, ${users.length} dispatchers, ${matcher.indexEntries} index entries`));
