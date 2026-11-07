// Plays the dispatchers using the product: each one saves their logins and searches through the API (behind nginx),
// checks their alerts every ~30 s, and re-saves their searches every ~10 min. The answer key in the world container
// is told about every dispatcher first, so it knows which alerts each one should get.
//   node cluster/dispatchers.ts --api http://engine-lb:8080 --world http://cluster-world:7003 --count 6000
import { Agent, createServer, request } from 'node:http';
import { parseArgs } from 'node:util';
import client from 'prom-client';
import { toUser } from '../src/data/users.ts';
import { createWorld } from '../sim/world.ts';

const { values: a } = parseArgs({ options: { api: { type: 'string', default: 'http://127.0.0.1:8080' }, world: { type: 'string', default: 'http://127.0.0.1:7003' },
  count: { type: 'string', default: '1000' }, seed: { type: 'string', default: '7' }, 'metrics-port': { type: 'string', default: '9464' },
  'check-every': { type: 'string', default: '30' }, 'save-every': { type: 'string', default: '600' } } });
const reg = new client.Registry();
const reqs = new client.Counter({ name: 'dispatcher_api_requests_total', help: 'API requests made by dispatchers', labelNames: ['route', 'status'], registers: [reg] });
const sec = new client.Histogram({ name: 'dispatcher_api_seconds', help: 'API round trip', labelNames: ['route'], registers: [reg], buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5] });
createServer(async (_req, res) => { res.writeHead(200, { 'content-type': reg.contentType }); res.end(await reg.metrics()); }).listen(Number(a['metrics-port']), '0.0.0.0');

const world = createWorld(Number(a.seed));
const users = Array.from({ length: Number(a.count) }, (_, i) => toUser(world.makeUser(i + 1)));
const api = new URL(a.api!);
const agent = new Agent({ keepAlive: true, maxSockets: 128 });
const call = (method: string, path: string, route: string, body?: unknown) => new Promise<number>((resolve) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const t0 = performance.now();
  const req = request({ host: api.hostname, port: api.port, path, method, agent, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
    res.resume();
    res.on('end', () => { reqs.inc({ route, status: String(res.statusCode) }); sec.observe({ route }, (performance.now() - t0) / 1000); resolve(res.statusCode ?? 0); });
  });
  req.on('error', () => { reqs.inc({ route, status: 'error' }); resolve(0); });
  req.end(data);
});
const save = (u: (typeof users)[number]) => call('PUT', `/api/dispatchers/${encodeURIComponent(u.userId)}`, 'save', u);
const check = (u: (typeof users)[number]) => call('GET', `/api/dispatchers/${encodeURIComponent(u.userId)}/alerts`, 'alerts');

// 1. The answer key learns about everyone, then 2. every dispatcher saves their searches through the API.
for (let i = 0; i < users.length; i += 500) {
  const r = await fetch(`${a.world}/dispatchers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(users.slice(i, i + 500)) });
  await r.arrayBuffer();
}
for (let i = 0; i < users.length; i += 64) await Promise.all(users.slice(i, i + 64).map(save));
console.log(`dispatchers: ${users.length} saved through ${a.api}`);

// 3. Ongoing use, spread evenly: check alerts every ~30 s, re-save searches every ~10 min.
const every = (seconds: number, f: (u: (typeof users)[number]) => Promise<number>) => {
  let i = 0;
  setInterval(() => { const n = Math.max(1, Math.round(users.length / seconds / 10)); for (let k = 0; k < n; k++) void f(users[i++ % users.length]); }, 100);
};
every(Number(a['check-every']), check);
every(Number(a['save-every']), save);
