// The engine: every hot-path stage in one process, state in memory, stages joined by bounded queues (LLD §1, §4).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSimClock, type Clock } from './shared/clock.ts';
import { createBoundedQueue } from './shared/queue.ts';
import type { Alert, Load, PlanEntry, RawPosting } from './shared/types.ts';
import { loadUsers } from './data/users.ts';
import { loadGazetteer } from './normalize/gazetteer.ts';
import { createNormalizer } from './normalize/normalize.ts';
import { createDedup } from './dedup/dedup.ts';
import { buildMatcher } from './match/matcher.ts';
import { createHeat } from './plan/heat.ts';
import { allocate, buildPlan } from './plan/planner.ts';
import { createScheduler, type SchedulerStats } from './schedule/scheduler.ts';
import { createPoller } from './poll/poller.ts';
import { createAlertQueue } from './alerts/alert-queue.ts';
import { createNotifier } from './alerts/notifier.ts';
import { setupObs } from './obs/obs.ts';

export type EngineConfig = { dataDir: string; boardsUrl: string; telegramUrl: string; clock: Clock; budgetPerMin: number; connectionsPerBoard: number; metricsPort: number | null; otlpEndpoint: string | null; sampleRate: number; maxUsers: number; bots: number };
export type EngineSummary = { polls: number; postings: number; newLoads: number; alertsQueued: number; alertsSent: number; alertsDropped: number; scheduler: SchedulerStats };

const here = dirname(fileURLToPath(import.meta.url));
const summarize = (l: Load) => `${l.origin.city}, ${l.origin.state} → ${l.dest.city}, ${l.dest.state} · ${l.equipment} · ${l.rate ? `$${l.rate}` : 'no rate'} · ${l.miles} mi · pickup ${l.pickupDate}`;

export async function startEngine(cfg: EngineConfig) {
  const { clock } = cfg;
  const all = loadUsers(join(cfg.dataDir, 'searches.ndjson'));
  const users = cfg.maxUsers > 0 ? all.slice(0, cfg.maxUsers) : all;
  const obs = setupObs({ sampleRate: cfg.sampleRate, otlpEndpoint: cfg.otlpEndpoint, metricsPort: cfg.metricsPort });
  const normalize = createNormalizer(loadGazetteer(join(here, '../sim/data')));
  const dedup = createDedup(clock);
  const matcher = buildMatcher(users.flatMap((u) => u.searches));
  const heat = createHeat(clock);
  const alertQueue = createAlertQueue({ clock, freshAfterMs: 10_000, deadlineMs: 10 * 60_000, ttlMs: 72 * 3_600_000 });
  const counts = { polls: 0, postings: 0, newLoads: 0, alertsQueued: 0, alertsSent: 0 };

  const pollQueue = createBoundedQueue<PlanEntry>(20_000);
  const rawQueue = createBoundedQueue<RawPosting>(100_000);
  const scheduler = createScheduler({ clock, budgetPerMin: cfg.budgetPerMin, dispatch: (e) => pollQueue.tryPush(e) });
  const rebuildPlans = () => {
    for (const u of users) {
      const plan = buildPlan(u, heat.get);
      for (const c of u.credentials) scheduler.setEntries(c.credentialId, allocate(plan.filter((e) => e.credentialId === c.credentialId), cfg.budgetPerMin));
    }
  };
  rebuildPlans();

  const poller = createPoller({ baseUrl: cfg.boardsUrl, connectionsPerBoard: cfg.connectionsPerBoard, clock, timeoutMs: 5_000,
    onResponse: (e, r) => {
      counts.polls++;
      scheduler.report(e.credentialId, r.status, r.retryAfterSec);
      obs.upstream(e.board, r.status, r.requestMs, r.poolWaitMs);
      for (const raw of r.items) {
        if (!rawQueue.tryPush({ board: e.board, credentialId: e.credentialId, userId: e.userId, entryId: e.entryId, fetchedAt: clock.now(), raw })) obs.overflow('raw');
      }
    } });

  const processOne = (r: RawPosting) => {
    counts.postings++;
    const t = obs.begin();
    const n = obs.stage('normalize', t, () => normalize(r));
    if (!n.ok) { obs.normalizeFailed(r.board, n.reason); obs.finish(t, { board: r.board, error: n.reason }); return; }
    const load = n.load;
    const d = obs.stage('dedup', t, () => dedup(load));
    obs.dedup(d.result);
    if (d.result === 'refresh' || d.result === 'updated') { obs.finish(t, { board: load.board, dedup: d.result }); return; }
    if (d.result === 'new') { counts.newLoads++; heat.record(load.origin.cell4.slice(0, 3), load.equipment); }
    const m = obs.stage('match', t, () => matcher.match(load));
    obs.fanout(m.candidates);
    let offered = 0;
    obs.stage('alert', t, () => {
      for (const [userId, searchIds] of m.users) {
        const a: Alert = { userId, canonicalId: load.canonicalId, loadKey: load.key, searchIds, summary: summarize(load), postedAt: load.postedAt, enqueuedAt: clock.now() };
        if (alertQueue.offer(a)) offered++;
      }
    });
    counts.alertsQueued += offered;
    obs.finish(t, { board: load.board, dedup: d.result, candidates: m.candidates, alerts: offered });
  };

  const notifier = createNotifier({ clock, queue: alertQueue, bots: cfg.bots, perBotPerSec: 30, perChatPerSec: 1, maxDigest: 5,
    send: async (botId, chatId, alerts) => {
      try {
        const res = await fetch(`${cfg.telegramUrl}/bot${botId}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: alerts.map((x) => x.summary).join('\n'), meta: { loads: alerts.map((x) => ({ loadKey: x.loadKey, canonicalId: x.canonicalId, postedAt: x.postedAt })) } }) });
        if (res.status === 429) { const j = (await res.json()) as { parameters?: { retry_after?: number } }; return { ok: false, retryAfterSec: j.parameters?.retry_after ?? 1 }; }
        await res.arrayBuffer();
        return { ok: res.ok };
      } catch { return { ok: false, retryAfterSec: 1 }; }
    },
    onSent: (alerts, at) => { counts.alertsSent += alerts.length; for (const x of alerts) obs.postToAlert((at - x.postedAt) / 1000); } });

  let running = true;
  const maxInFlight = cfg.connectionsPerBoard * 4;
  const pumpPolls = async () => {
    while (running) {
      await Promise.race([pollQueue.waitForItems(), new Promise((r) => setTimeout(r, 50))]);
      while (running && pollQueue.size() && poller.inFlight() < maxInFlight) {
        for (const e of pollQueue.takeBatch(maxInFlight - poller.inFlight()).items) void poller.poll(e);
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  const pumpProcessing = async () => {
    while (running) {
      await Promise.race([rawQueue.waitForItems(), new Promise((r) => setTimeout(r, 50))]);
      const { items, waitsMs } = rawQueue.takeBatch(500);
      for (const r of items) processOne(r);
      obs.queueWait('raw', waitsMs);
      obs.flush();
      await new Promise((r) => setImmediate(r));
    }
  };
  // Sleep in short real-time chunks so stop() is noticed quickly (a 10-minute sleep would keep the process alive).
  const loop = async (fn: () => unknown, simMs: number) => {
    while (running) {
      await fn();
      const until = clock.now() + Math.max(simMs, 5 * clock.speed);
      while (running && clock.now() < until) await clock.sleep(Math.min(until - clock.now(), 200 * clock.speed));
    }
  };

  void pumpPolls();
  void pumpProcessing();
  void loop(() => scheduler.tick(), 20);
  void loop(() => notifier.tick(), 50);
  void loop(() => rebuildPlans(), 10 * 60_000);
  const gaugeTimer = setInterval(() => {
    const s = scheduler.stats();
    obs.gauges({ poll_queue: pollQueue.size(), raw_queue: rawQueue.size(), alert_queue: alertQueue.size(), alert_queue_oldest_wait_ms: alertQueue.oldestWaitMs(),
      alerts_dropped_stale: alertQueue.dropped(), polls_in_flight: poller.inFlight(), logins_paused: s.paused, logins_banned: s.banned, scheduler_stretch: s.stretch, notifier_held: notifier.held() });
  }, 1_000);

  return {
    async stop(): Promise<EngineSummary> {
      running = false;
      clearInterval(gaugeTimer);
      await poller.close();
      await obs.close();
      return { ...counts, alertsDropped: alertQueue.dropped(), scheduler: scheduler.stats() };
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: {
    data: { type: 'string', default: 'out' }, boards: { type: 'string', default: 'http://127.0.0.1:7001' }, telegram: { type: 'string', default: 'http://127.0.0.1:7002' },
    'sim-start': { type: 'string' }, 'real-start': { type: 'string' }, speed: { type: 'string', default: '1' }, budget: { type: 'string', default: '60' },
    connections: { type: 'string', default: '64' }, 'metrics-port': { type: 'string', default: '9464' }, otlp: { type: 'string', default: 'off' },
    sample: { type: 'string', default: '0.01' }, users: { type: 'string', default: '0' }, bots: { type: 'string', default: '4' } } });
  const clock = createSimClock({ simStart: Date.parse(a['sim-start']!), realStart: Number(a['real-start']), speed: Number(a.speed) });
  const engine = await startEngine({ dataDir: a.data!, boardsUrl: a.boards!, telegramUrl: a.telegram!, clock, budgetPerMin: Number(a.budget),
    connectionsPerBoard: Number(a.connections), metricsPort: Number(a['metrics-port']) || null, otlpEndpoint: a.otlp === 'off' ? null : a.otlp!,
    sampleRate: Number(a.sample), maxUsers: Number(a.users), bots: Number(a.bots) });
  console.log('engine started');
  const stop = async () => { console.log(`ENGINE_SUMMARY ${JSON.stringify(await engine.stop())}`); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
