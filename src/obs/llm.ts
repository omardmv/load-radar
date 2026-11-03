// LLM observability: every model call becomes one OpenTelemetry span following the GenAI conventions.
// The collector sends these spans to Langfuse (what the model saw, what it returned, tokens, latency, errors),
// turns them into Prometheus metrics (llm_calls_total, llm_duration_*), and Jaeger keeps them with everything else.
// Code only speaks OpenTelemetry, so Langfuse can be swapped for another backend in collector config.
import { SpanKind, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

export type LlmTracing = { tracer: Tracer | null; shutdown(): Promise<void> };

export function setupLlmTracing(opts: { endpoint: string | null; serviceName: string }): LlmTracing {
  if (!opts.endpoint) return { tracer: null, shutdown: async () => {} };
  // Node provider + register(): the active span follows async calls, so a model call made while handling a request
  // becomes a child of that request's span (one trace per request: every step, the prompt, the output).
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': opts.serviceName }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.endpoint }), { scheduledDelayMillis: 1_000 })],
  });
  provider.register();
  return { tracer: provider.getTracer('load-radar-llm'), shutdown: async () => { await provider.forceFlush(); await provider.shutdown(); } };
}

export type LlmCallInfo = {
  system: string;                         // provider or engine: 'ollama', 'gliner2', 'anthropic', ...
  model: string;
  operation: 'chat' | 'extract';
  input: unknown;                         // exactly what the model receives (messages, schema, text)
  params?: Record<string, number | string>;   // e.g. temperature
  sessionId?: string;                     // groups calls in Langfuse (e.g. one eval run)
  metadata?: Record<string, string>;
};
export type LlmCallResult<T> = { value: T; output: unknown; responseModel?: string; inputTokens?: number | null; outputTokens?: number | null };
export type TracedResult<T> = LlmCallResult<T> & { traceId: string | null; observationId: string | null; latencyMs: number };

export async function traceLlmCall<T>(tracer: Tracer | null, info: LlmCallInfo, fn: () => Promise<LlmCallResult<T>>): Promise<TracedResult<T>> {
  const t0 = performance.now();
  if (!tracer) { const r = await fn(); return { ...r, traceId: null, observationId: null, latencyMs: performance.now() - t0 }; }
  const span = tracer.startSpan(`${info.operation} ${info.model}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.system': info.system,
      'gen_ai.operation.name': info.operation,
      'gen_ai.request.model': info.model,
      'langfuse.observation.type': 'generation',
      'langfuse.observation.input': JSON.stringify(info.input),
      ...(info.sessionId ? { 'langfuse.session.id': info.sessionId } : {}),
      ...Object.fromEntries(Object.entries(info.params ?? {}).map(([k, v]) => [`gen_ai.request.${k}`, v])),
      ...Object.fromEntries(Object.entries(info.metadata ?? {}).map(([k, v]) => [`langfuse.observation.metadata.${k}`, v])),
    },
  });
  try {
    const r = await fn();
    span.setAttribute('langfuse.observation.output', JSON.stringify(r.output));
    if (r.responseModel) span.setAttribute('gen_ai.response.model', r.responseModel);
    if (r.inputTokens != null) span.setAttribute('gen_ai.usage.input_tokens', r.inputTokens);
    if (r.outputTokens != null) span.setAttribute('gen_ai.usage.output_tokens', r.outputTokens);
    const ctx = span.spanContext();
    return { ...r, traceId: ctx.traceId, observationId: ctx.spanId, latencyMs: performance.now() - t0 };
  } catch (e) {
    span.recordException(e as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
    span.setAttribute('langfuse.observation.level', 'ERROR');
    throw e;
  } finally {
    span.end();
  }
}
