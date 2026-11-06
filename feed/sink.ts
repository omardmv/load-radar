// Alert sink for the push-feed test: stands in for Telegram/push and scores what the ingest workers send.
// Duplicates: the same (dispatcher, real load) alerted more than once. The real load id comes from the generator's
// truth, which the workers never use for decisions. To keep memory flat, only loads whose id hashes into a 1-in-10
// sample are tracked for duplicates; the share is the same.
//   node feed/sink.ts --port 7300 --metrics-port 9464     (POST /reset clears the duplicate memory between runs)
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import client from 'prom-client';

const { values: a } = parseArgs({ options: { port: { type: 'string', default: '7300' }, 'metrics-port': { type: 'string', default: '9464' } } });
const reg = new client.Registry();
client.collectDefaultMetrics({ register: reg });
const alerts = new client.Counter({ name: 'feed_sink_alerts_total', help: 'alerts received (workers send a 1-in-10 sample of loads)', registers: [reg] });
const sampled = new client.Counter({ name: 'feed_sink_sampled_total', help: 'alerts in the 1-in-10 duplicate sample', labelNames: ['kind'], registers: [reg] });
const latency = new client.Histogram({ name: 'feed_alert_seconds', help: 'partner sent the posting -> alert reached the sink', registers: [reg], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60] });
sampled.inc({ kind: 'first' }, 0); sampled.inc({ kind: 'duplicate' }, 0);
createServer(async (_req, res) => { res.writeHead(200, { 'content-type': reg.contentType }); res.end(await reg.metrics()); }).listen(Number(a['metrics-port']), '0.0.0.0');

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
let seen = new Set<string>();
type In = { user: string; load: string; sentAt: number; worker: string };
createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/reset') { seen = new Set(); res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST' || req.url !== '/alerts') { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const now = Date.now();
    for (const x of JSON.parse(Buffer.concat(chunks).toString()) as In[]) {
      alerts.inc();
      latency.observe((now - x.sentAt) / 1000);
      if (hash(x.load) % 10 !== 0) continue;
      const k = `${x.user}|${x.load}`;
      if (seen.has(k)) sampled.inc({ kind: 'duplicate' }); else { seen.add(k); sampled.inc({ kind: 'first' }); }
    }
    res.writeHead(200); res.end();
  });
}).listen(Number(a.port), '0.0.0.0', () => console.log(`sink on :${a.port}`));
