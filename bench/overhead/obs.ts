// Observability modes for the overhead test, and the stage() wrapper every stage goes through.
//   none      no metrics, no tracing
//   metrics   prom-client RED metrics per stage (+ a /metrics scrape every 15 s)
//   trace1    metrics + tracing, 1% of postings sampled at the head
//   trace100  metrics + tracing, every posting (what collector-side tail sampling needs from the app)
// Fixes tested after the first run showed tracing costs 12–17%:
//   trace1lazy    1%, but stage spans are created only when the root span is sampled
//   trace1self    1%, sampling decided by us before touching the SDK (99% of postings skip it entirely)
//   trace100flat  100%, one span per posting with stage timings as attributes (1 span instead of 5)
// Fix tested after metrics alone measured +5.0%:
//   metricslite     counters kept as plain numbers and added to prom-client once per batch;
//                   stage timings measured for 1 posting in 16 only
//   trace1selflite  metricslite + trace1self (the configuration we'd ship)

import { trace, context, diag, DiagLogLevel, type Span, type Context } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import client from 'prom-client';

export type Mode = 'none' | 'metrics' | 'trace1' | 'trace100' | 'trace1lazy' | 'trace1self' | 'trace100flat' | 'metricslite' | 'trace1selflite';
export const STAGES = ['normalize', 'dedup', 'match', 'alert'] as const;
type Stage = typeof STAGES[number];

export function setupObservability(mode: Mode, opts: { endpoint: string; maxQueueSize?: number }) {
  const metricsOn = mode !== 'none';
  const tracingOn = mode.startsWith('trace');
  const lazy = mode === 'trace1lazy', self = mode.startsWith('trace1self'), flat = mode === 'trace100flat';
  const lite = mode.endsWith('lite');
  const TIME_EVERY = 16;   // lite: time 1 posting in 16
  const dropped = { spans: 0 };

  // ---------- metrics ----------
  const registry = new client.Registry();
  const duration = new client.Histogram({ name: 'stage_duration_seconds', help: 'time per item per stage', labelNames: ['stage'], registers: [registry],
    buckets: [0.000005, 0.00001, 0.000025, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.01] });
  const items = new client.Counter({ name: 'stage_items_total', help: 'items processed per stage', labelNames: ['stage'], registers: [registry] });
  const dedupTotal = new client.Counter({ name: 'dedup_total', help: 'dedup results', labelNames: ['result'], registers: [registry] });
  const fanout = new client.Histogram({ name: 'match_fanout', help: 'candidates per load', registers: [registry], buckets: [1, 10, 100, 1000, 10000] });
  // bind label values once: looking labels up per observation is a hidden per-item cost
  const durBy = Object.fromEntries(STAGES.map((s) => [s, duration.labels(s)])) as Record<Stage, client.Histogram.Internal<string>>;
  const itemsBy = Object.fromEntries(STAGES.map((s) => [s, items.labels(s)])) as Record<Stage, client.Counter.Internal<string>>;
  if (metricsOn) client.collectDefaultMetrics({ register: registry });   // event loop lag, GC, heap

  // ---------- tracing ----------
  let provider: BasicTracerProvider | null = null;
  if (tracingOn) {
    diag.setLogger({
      warn: (msg: string) => { const m = /Dropped (\d+) spans/.exec(msg); if (m) dropped.spans += Number(m[1]); },
      error: () => {}, info: () => {}, debug: () => {}, verbose: () => {},
    }, DiagLogLevel.WARN);
    const sampler = mode.startsWith('trace100') || self ? new AlwaysOnSampler() : new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.01) });
    provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ 'service.name': 'load-radar-engine' }),
      sampler,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.endpoint }), { maxQueueSize: opts.maxQueueSize ?? 2048 })],
    });
  }
  const tracer = provider?.getTracer('load-radar');

  // One trace per posting: a root span plus one child span per stage.
  let seq = 0;
  type T = { root: Span | null; ctx: Context | null; timed: boolean };
  const begin = (): T => {
    const timed = !lite || (seq++ % TIME_EVERY) === 0;
    if (!tracer) return { root: null, ctx: null, timed };
    if (self && Math.random() >= 0.01) return { root: null, ctx: null, timed };   // unsampled: never call the SDK
    const root = tracer.startSpan('posting');
    return { root, ctx: trace.setSpan(context.active(), root), timed: true };    // a sampled posting is always timed
  };
  // lite: plain-number counters, added to prom-client once per batch by flush()
  const localItems: Record<Stage, number> = { normalize: 0, dedup: 0, match: 0, alert: 0 };
  const localDedup: Record<string, number> = {};
  const dedupBy: Record<string, client.Counter.Internal<string>> = {};
  let fanSeq = 0;
  // The wrapper every stage goes through: RED metrics + a span, or nothing in 'none' mode.
  function stage<R>(name: Stage, t: T, fn: (span: Span | null) => R): R {
    if (!metricsOn) return fn(null);
    if (lite && !t.timed) { localItems[name]++; return fn(null); }
    const childOk = tracer && t.ctx && !flat && (!lazy || t.root!.isRecording());
    const span = childOk ? tracer!.startSpan(name, undefined, t.ctx!) : null;
    const start = performance.now();
    try { return fn(flat ? t.root : span); }
    finally {
      const sec = (performance.now() - start) / 1000;
      durBy[name].observe(sec);
      if (lite) localItems[name]++; else itemsBy[name].inc();
      if (flat && t.root) t.root.setAttribute(`${name}_ms`, sec * 1000);
      span?.end();
    }
  }
  return {
    metricsOn, tracingOn, dropped, begin, stage,
    dedupResult: (r: string) => { if (!metricsOn) return; if (lite) localDedup[r] = (localDedup[r] ?? 0) + 1; else dedupTotal.labels(r).inc(); },
    fanout: (n: number) => { if (metricsOn && (!lite || (fanSeq++ % TIME_EVERY) === 0)) fanout.observe(n); },
    flush: () => {   // once per batch: hand the plain-number counts to prom-client
      if (!lite) return;
      for (const st of STAGES) if (localItems[st]) { itemsBy[st].inc(localItems[st]); localItems[st] = 0; }
      for (const r in localDedup) if (localDedup[r]) { (dedupBy[r] ??= dedupTotal.labels(r)).inc(localDedup[r]); localDedup[r] = 0; }
    },
    scrape: async () => (metricsOn ? (await registry.metrics()).length : 0),
    shutdown: async () => { await provider?.forceFlush(); await provider?.shutdown(); },
  };
}
