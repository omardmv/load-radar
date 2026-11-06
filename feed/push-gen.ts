// Partner push-feed generator: plays the brokers and partners who push every posting to us as one HTTP POST.
// The same simulated world as live mode (loads, refreshes, reposts, cross-posts, co-broker copies), sent as fast as
// the target accepts with `--concurrency` requests in flight per thread (closed loop: it measures max throughput).
//
// Each request carries X-Route-Key = origin state | destination state | pickup date | equipment. Every copy of one
// load shares it, so a load balancer hashing on it sends all copies to the same ingest worker. Partners wouldn't
// send our key in production: a stateless edge tier (or Kafka's partition key) would compute it; this stands in.
//
//   node feed/push-gen.ts --target http://feed-lb:8091 --threads 2 --concurrency 128 --metrics-port 9464
import { createServer, Agent, request } from 'node:http';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import client from 'prom-client';
import { createFakeClock } from '../src/shared/clock.ts';
import { createWorld } from '../sim/world.ts';
import { createStream, type Released } from '../live/stream.ts';

type Opts = { target: string; concurrency: number; metricsPort: number; seed: number };
if (isMainThread) {
  const { values: a } = parseArgs({ options: { target: { type: 'string', default: 'http://127.0.0.1:8091' }, threads: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '128' }, 'metrics-port': { type: 'string', default: '9464' }, seed: { type: 'string', default: '11' } } });
  for (let i = 0; i < Number(a.threads); i++) {
    new Worker(new URL(import.meta.url), { workerData: { target: a.target!, concurrency: Number(a.concurrency), metricsPort: Number(a['metrics-port']) + i, seed: Number(a.seed) + i * 1000 } satisfies Opts });
  }
  console.log(`push-gen: ${a.threads} threads x ${a.concurrency} in flight -> ${a.target}`);
} else {
  const o = workerData as Opts;
  const reg = new client.Registry();
  client.collectDefaultMetrics({ register: reg });
  const sent = new client.Counter({ name: 'feed_gen_requests_total', help: 'postings pushed, by HTTP status', labelNames: ['status'], registers: [reg] });
  const sec = new client.Histogram({ name: 'feed_gen_request_seconds', help: 'push request round trip', registers: [reg], buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1] });
  createServer(async (_req, res) => { res.writeHead(200, { 'content-type': reg.contentType }); res.end(await reg.metrics()); }).listen(o.metricsPort, '0.0.0.0');

  // The world runs on a clock we push forward ourselves: whenever the outbox runs low, advance a simulated minute.
  const clock = createFakeClock(Date.now());
  const outbox: Released[] = [];
  const stream = createStream({ world: createWorld(o.seed), clock, loadsPerDay: 200_000, onLoad: () => {}, onPosting: (p) => outbox.push(p) });
  let read = 0, sinceprune = 0;
  const next = (): Released => {
    while (read >= outbox.length) {
      outbox.length = 0; read = 0;
      clock.advance(60_000); stream.tick();
      if (++sinceprune >= 30) { stream.prune(); sinceprune = 0; }
    }
    return outbox[read++];
  };

  const url = new URL(o.target);
  const agent = new Agent({ keepAlive: true, maxSockets: o.concurrency });
  const send = (p: Released) => new Promise<void>((resolve) => {
    const t = p.truth;
    const body = JSON.stringify({ board: p.board, raw: p.raw, load_id: `${o.seed}-${t.load_id}`, sent_at: Date.now() });   // each thread's world numbers loads from 1
    const t0 = performance.now();
    const req = request({ host: url.hostname, port: url.port, path: '/loads', method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-route-key': `${t.origin.state}|${t.dest.state}|${t.pickup_date}|${t.equipment}` } }, (res) => {
      res.resume();
      res.on('end', () => { sent.inc({ status: String(res.statusCode) }); sec.observe((performance.now() - t0) / 1000); resolve(); });
    });
    req.on('error', () => { sent.inc({ status: 'error' }); setTimeout(resolve, 100); });
    req.end(body);
  });
  const lane = async () => { for (;;) await send(next()); };
  for (let i = 0; i < o.concurrency; i++) void lane();
}
