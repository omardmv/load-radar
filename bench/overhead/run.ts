// One benchmark run: replay postings through the engine core in one observability mode, measure CPU.
//   node bench/overhead/run.ts --mode trace1 --rate 5000 --seconds 30 --warmup 5 --data /tmp/lr/v6
//   --rate 0 means "as fast as possible" (throughput mode)
// Prints one JSON line with the result.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadGazetteer, makeNormalizer, makeDedup, loadMatcher, makeAlerts, type Counters } from './core.ts';
import { setupObservability, type Mode } from './obs.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<[string, string][]>((a, x, i, all) => (x.startsWith('--') && a.push([x.slice(2), all[i + 1]]), a), []));
const mode = (args.mode ?? 'none') as Mode;
const RATE = Number(args.rate ?? 5000), SECONDS = Number(args.seconds ?? 30), WARMUP = Number(args.warmup ?? 5);
const SHARED = Number(args.shared ?? 0.1);       // share of postings from shared feeds (visible to every user)
const data = args.data ?? 'out';
const here = dirname(fileURLToPath(import.meta.url));

// ---------- setup (not measured) ----------
const lines = readFileSync(join(data, 'postings.ndjson'), 'utf8').trim().split('\n');
const counters: Counters = { unknownPlace: 0, unknownEquip: 0 };
const normalize = makeNormalizer(loadGazetteer(join(here, '../../sim/data')), counters);
const dedup = makeDedup();
const matcher = loadMatcher(join(data, 'searches.ndjson'));
const alerts = makeAlerts();
const obs = setupObservability(mode, { endpoint: args.endpoint ?? 'http://127.0.0.1:4318/v1/traces', maxQueueSize: args.queue ? Number(args.queue) : undefined });
let seed = 42; const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---------- the pipeline for one posting ----------
let alertsMade = 0;
function processOne(line: string) {
  const t = obs.begin();
  const p = JSON.parse(line);                                   // stands in for parsing a board response
  const load = obs.stage('normalize', t, () => normalize(p.board, p.raw));
  if (!load) { t.root?.end(); return; }
  const d = obs.stage('dedup', t, (span) => { const r = dedup(load); span?.setAttribute('result', r.result); return r; });
  obs.dedupResult(d.result);
  if (d.result === 'refresh' || d.result === 'updated') { t.root?.end(); return; }
  const m = obs.stage('match', t, (span) => { const r = matcher.match(load); span?.setAttribute('candidates', r.candidates); return r; });
  obs.fanout(m.candidates);
  // Entitlement: a posting fetched with one customer's login can only alert that customer.
  let users = m.users;
  if (users.size > 1 && rand() >= SHARED) { const keys = [...users.keys()]; const one = keys[Math.floor(rand() * keys.length)]; users = new Map([[one, users.get(one)!]]); }
  alertsMade += obs.stage('alert', t, () => alerts.enqueue(load, users));
  alerts.drain(1000);                                            // the notifier takes alerts off the heap
  t.root?.end();
}

// ---------- run ----------
let i = 0;
const tick = (n: number) => { const end = Math.min(i + n, lines.length); while (i < end) processOne(lines[i++]); obs.flush(); };
const delay = monitorEventLoopDelay({ resolution: 10 });
const scrapeTimer = setInterval(() => { void obs.scrape(); }, 15_000);
const start = performance.now();
let measureStart = 0, cpu0 = process.cpuUsage(), elu0 = performance.eventLoopUtilization(), processedAtMeasure = 0, behindMax = 0, ranOut = false;

await new Promise<void>((resolve) => {
  const loop = () => {
    const elapsed = (performance.now() - start) / 1000;
    if (!measureStart && elapsed >= WARMUP) { measureStart = performance.now(); cpu0 = process.cpuUsage(); elu0 = performance.eventLoopUtilization(); processedAtMeasure = i; delay.enable(); }
    if (elapsed >= WARMUP + SECONDS) return resolve();
    if (i >= lines.length) { ranOut = true; return resolve(); }
    if (RATE > 0) {
      const due = Math.floor(elapsed * RATE);
      if (measureStart) behindMax = Math.max(behindMax, due - i);
      tick(due - i);
      setTimeout(loop, 10);
    } else { tick(500); setImmediate(loop); }   // throughput mode: yield often so exports and timers still run
  };
  loop();
});

const wall = (performance.now() - measureStart) / 1000;
const cpu = process.cpuUsage(cpu0);
const elu = performance.eventLoopUtilization(elu0);
delay.disable(); clearInterval(scrapeTimer);
const processed = i - processedAtMeasure;
await obs.shutdown();
let sink = { spans: 0 };
if (obs.tracingOn) { try { sink = await (await fetch((args.endpoint ?? 'http://127.0.0.1:4318/v1/traces').replace('/v1/traces', '/stats'))).json(); } catch {} }
const mem = process.memoryUsage();
console.log(JSON.stringify({
  mode, rate: RATE, seconds: +wall.toFixed(2), processed, postingsPerSec: Math.round(processed / wall),
  cpuCores: +((cpu.user + cpu.system) / 1e6 / wall).toFixed(4),
  cpuUsPerPosting: +((cpu.user + cpu.system) / processed).toFixed(2),
  eventLoopUtilization: +elu.utilization.toFixed(4), loopDelayP99ms: +(delay.percentile(99) / 1e6).toFixed(2),
  behindMax, ranOut, alerts: alertsMade, droppedSpans: obs.dropped.spans, sinkSpans: sink.spans,
  heapMB: Math.round(mem.heapUsed / 1e6), unknownPlace: counters.unknownPlace,
}));
process.exit(0);
