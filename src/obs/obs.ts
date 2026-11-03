import { createServer, type Server } from 'node:http';
import client from 'prom-client';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

export const STAGES = ['normalize', 'dedup', 'match', 'alert'] as const;
export type Stage = (typeof STAGES)[number];
export type PostingTrace = { sampled: boolean; timed: boolean; startWall: number; startPerf: number; stageMs: Record<string, number> };

// The measured configuration from bench/overhead/RESULTS.md (+1.0% CPU).
export function setupObs(opts: { sampleRate: number; otlpEndpoint: string | null; metricsPort: number | null; timeEvery?: number }) {
  const timeEvery = opts.timeEvery ?? 16;
  const reg = new client.Registry();
  client.collectDefaultMetrics({ register: reg });
  const dur = new client.Histogram({ name: 'stage_duration_seconds', help: 'time per posting per stage (1 in N postings)', labelNames: ['stage'], registers: [reg], buckets: [0.000005, 0.00001, 0.000025, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.01] });
  const items = new client.Counter({ name: 'stage_items_total', help: 'postings processed per stage', labelNames: ['stage'], registers: [reg] });
  const dedupC = new client.Counter({ name: 'dedup_total', help: 'dedup results', labelNames: ['result'], registers: [reg] });
  const fanoutH = new client.Histogram({ name: 'match_fanout', help: 'candidate searches per new load (1 in N)', registers: [reg], buckets: [1, 10, 100, 1000, 10000] });
  const normFail = new client.Counter({ name: 'normalize_failed_total', help: 'postings dropped by the normalizer', labelNames: ['board', 'reason'], registers: [reg] });
  const upReq = new client.Counter({ name: 'upstream_requests_total', help: 'board requests by status', labelNames: ['board', 'status'], registers: [reg] });
  const upSec = new client.Histogram({ name: 'upstream_request_seconds', help: 'board response time, excluding pool wait', labelNames: ['board'], registers: [reg], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] });
  const poolWait = new client.Histogram({ name: 'http_pool_wait_seconds', help: 'time waiting for a free socket', labelNames: ['board'], registers: [reg], buckets: [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5] });
  const p2a = new client.Histogram({ name: 'post_to_alert_seconds', help: 'board posted_at to Telegram accepted (simulated seconds)', registers: [reg], buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300, 600] });
  const qWait = new client.Histogram({ name: 'stage_queue_wait_seconds', help: 'time in a stage queue (1 in N)', labelNames: ['queue'], registers: [reg], buckets: [0.0001, 0.001, 0.01, 0.1, 1, 10] });
  const overflowC = new client.Counter({ name: 'queue_overflow_total', help: 'items refused by a full queue', labelNames: ['queue'], registers: [reg] });
  const gauge = new client.Gauge({ name: 'engine_gauge', help: 'engine state (queue depths, logins paused or banned, ...)', labelNames: ['name'], registers: [reg] });
  const dropped = new client.Counter({ name: 'spans_dropped_total', help: 'spans dropped by the exporter queue', registers: [reg] });
  const durBy = Object.fromEntries(STAGES.map((s) => [s, dur.labels(s)]));
  const itemsBy = Object.fromEntries(STAGES.map((s) => [s, items.labels(s)]));

  let droppedSpans = 0;
  let provider: BasicTracerProvider | null = null;
  if (opts.otlpEndpoint) {
    diag.setLogger({ warn: (m: string) => { const x = /Dropped (\d+) spans/.exec(m); if (x) { droppedSpans += Number(x[1]); dropped.inc(Number(x[1])); } }, error: () => {}, info: () => {}, debug: () => {}, verbose: () => {} }, DiagLogLevel.WARN);
    provider = new BasicTracerProvider({ resource: resourceFromAttributes({ 'service.name': 'load-radar-engine' }), sampler: new AlwaysOnSampler(),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.otlpEndpoint }), { maxQueueSize: 8192 })] });
  }
  const tracer = provider?.getTracer('load-radar');

  const localItems: Record<string, number> = { normalize: 0, dedup: 0, match: 0, alert: 0 };
  const localDedup: Record<string, number> = {};
  let seq = 0, fanSeq = 0, waitSeq = 0;
  let server: Server | null = null;
  if (opts.metricsPort) {
    server = createServer(async (req, res) => {
      if (req.url !== '/metrics') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': reg.contentType });
      res.end(await reg.metrics());
    }).listen(opts.metricsPort, '0.0.0.0');
  }

  return {
    begin(): PostingTrace {
      const sampled = tracer !== undefined && Math.random() < opts.sampleRate;   // decided here: unsampled postings never touch the SDK
      return { sampled, timed: sampled || seq++ % timeEvery === 0, startWall: Date.now(), startPerf: performance.now(), stageMs: {} };
    },
    stage<R>(name: Stage, t: PostingTrace, fn: () => R): R {
      localItems[name]++;
      if (!t.timed) return fn();
      const s = performance.now();
      try { return fn(); } finally { const ms = performance.now() - s; durBy[name].observe(ms / 1000); t.stageMs[`${name}_ms`] = ms; }
    },
    finish(t: PostingTrace, attrs: Record<string, string | number>) {
      if (!tracer || !(t.sampled || 'error' in attrs)) return;
      const span = tracer.startSpan('posting', { startTime: t.startWall, attributes: { ...attrs, ...t.stageMs } });
      span.end(t.startWall + (performance.now() - t.startPerf));
    },
    dedup(result: string) { localDedup[result] = (localDedup[result] ?? 0) + 1; },
    fanout(n: number) { if (fanSeq++ % timeEvery === 0) fanoutH.observe(n); },
    normalizeFailed(board: string, reason: string) { normFail.labels(board, reason).inc(); },
    upstream(board: string, status: number, requestMs: number, poolWaitMs: number) {
      upReq.labels(board, String(status)).inc();
      upSec.labels(board).observe(requestMs / 1000);
      poolWait.labels(board).observe(poolWaitMs / 1000);
    },
    postToAlert(seconds: number) { p2a.observe(seconds); },
    queueWait(queue: string, waitsMs: number[]) { for (const w of waitsMs) if (waitSeq++ % timeEvery === 0) qWait.labels(queue).observe(w / 1000); },
    overflow(queue: string) { overflowC.labels(queue).inc(); },
    gauges(values: Record<string, number>) { for (const [k, v] of Object.entries(values)) gauge.labels(k).set(v); },
    flush() {
      for (const s of STAGES) if (localItems[s]) { itemsBy[s].inc(localItems[s]); localItems[s] = 0; }
      for (const r in localDedup) if (localDedup[r]) { dedupC.labels(r).inc(localDedup[r]); localDedup[r] = 0; }
    },
    metricsText: () => reg.metrics(),
    spansDropped: () => droppedSpans,
    async close() { await provider?.forceFlush(); await provider?.shutdown(); server?.close(); },
  };
}
