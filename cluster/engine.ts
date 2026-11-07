// One engine worker as its own container. It starts with no dispatchers: it owns the dispatchers whose API requests
// nginx sends to it (nginx hashes on the dispatcher id, so one dispatcher always reaches the same worker), and it
// polls the boards for those dispatchers only. Several of these run behind nginx (cluster/nginx.conf).
//
//   PUT /api/dispatchers/:id          save the dispatcher's logins and searches; this worker now owns them
//   GET /api/dispatchers/:id/alerts   the dispatcher's recent alerts (404 if this worker doesn't own them)
//   node cluster/engine.ts --boards http://cluster-world:7001 --alerts http://cluster-world:7002
import { createServer, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import client from 'prom-client';
import { createSimClock } from '../src/shared/clock.ts';
import type { Alert, User } from '../src/shared/types.ts';
import { startEngine } from '../src/engine.ts';

const { values: a } = parseArgs({ options: { port: { type: 'string', default: '8080' }, 'metrics-port': { type: 'string', default: '9464' },
  boards: { type: 'string', default: 'http://127.0.0.1:7001' }, alerts: { type: 'string', default: 'http://127.0.0.1:7002' },
  budget: { type: 'string', default: '60' }, 'dedup-model': { type: 'string', default: 'ml/dedup/model.json' } } });
const worker = hostname();
const users: User[] = [];
const recent = new Map<string, { at: number; summary: string }[]>();      // last 20 alerts per dispatcher
const engine = await startEngine({ users, boardsUrl: a.boards!, telegramUrl: a.alerts!, clock: createSimClock({ simStart: Date.now(), speed: 1 }),
  budgetPerMin: Number(a.budget), connectionsPerBoard: 64, metricsPort: Number(a['metrics-port']), otlpEndpoint: null, sampleRate: 0, maxUsers: 0,
  bots: 4, botPrefix: `${worker}-`, dedupModel: a['dedup-model'] || null,
  onAlertsSent: (alerts: Alert[], at: number) => {
    for (const x of alerts) { const l = recent.get(x.userId) ?? []; l.unshift({ at, summary: x.summary }); if (l.length > 20) l.pop(); recent.set(x.userId, l); }
  } });

// Saving searches rebuilds the index and every polling plan, so changes are applied at most once a second.
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; engine.refreshSearches(); } }, 1_000);

const reg = new client.Registry();
const api = new client.Counter({ name: 'engine_api_requests_total', help: 'dispatcher API requests', labelNames: ['route', 'status'], registers: [reg] });
new client.Gauge({ name: 'engine_dispatchers_owned', help: 'dispatchers this worker owns', registers: [reg], collect() { this.set(users.length); } });
const json = (res: ServerResponse, status: number, route: string, body: unknown) => { api.inc({ route, status: String(status) }); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = createServer((req, res) => {
  if (req.url === '/metrics') { void reg.metrics().then((m) => { res.writeHead(200, { 'content-type': reg.contentType }); res.end(m); }); return; }
  const m = /^\/api\/dispatchers\/([^/]+)(\/alerts)?$/.exec(req.url ?? '');
  if (!m) return json(res, 404, 'other', { error: 'not_found' });
  const id = decodeURIComponent(m[1]);
  if (req.method === 'GET' && m[2]) {
    if (!users.some((u) => u.userId === id)) return json(res, 404, 'alerts', { error: 'not_owned_here', worker });
    return json(res, 200, 'alerts', { worker, alerts: recent.get(id) ?? [] });
  }
  if (req.method === 'PUT' && !m[2]) {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = JSON.parse(Buffer.concat(chunks).toString()) as User;
      const i = users.findIndex((x) => x.userId === id);
      if (i >= 0) users[i].searches = u.searches, users[i].credentials = u.credentials; else users.push({ ...u, userId: id });
      dirty = true;
      json(res, 200, 'save', { worker, dispatchers: users.length });
    });
    return;
  }
  json(res, 405, 'other', { error: 'method_not_allowed' });
});
server.keepAliveTimeout = 65_000;      // longer than nginx keeps idle upstream connections (60 s)
server.headersTimeout = 66_000;
server.listen(Number(a.port), '0.0.0.0', () => console.log(`engine ${worker}: API :${a.port}, engine metrics :${a['metrics-port']}`));
