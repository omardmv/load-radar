// Structured logs: one JSON line per event to stdout, and the same record over OTLP to Loki (via the collector).
// Each record carries the active trace and span ids, so Grafana jumps from a log line to its trace and back.
import { context, trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

type Level = 'debug' | 'info' | 'warn' | 'error';
const SEVERITY: Record<Level, SeverityNumber> = { debug: SeverityNumber.DEBUG, info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR };
export type Attrs = Record<string, string | number | boolean | null | undefined>;
export type Log = (level: Level, event: string, attrs?: Attrs) => void;

export function setupLogs(opts: { endpoint: string | null; serviceName: string }): { log: Log; shutdown(): Promise<void> } {
  const provider = opts.endpoint ? new LoggerProvider({ resource: resourceFromAttributes({ 'service.name': opts.serviceName }),
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: opts.endpoint }), scheduledDelayMillis: 1_000 })] }) : null;   // this SDK version takes one options object
  const logger = provider?.getLogger('load-radar');
  const log: Log = (level, event, attrs = {}) => {
    const span = trace.getSpan(context.active())?.spanContext();
    const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null)) as Record<string, string | number | boolean>;
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...clean, ...(span ? { trace_id: span.traceId, span_id: span.spanId } : {}) }));
    logger?.emit({ severityNumber: SEVERITY[level], severityText: level.toUpperCase(), body: event, attributes: { event, ...clean }, context: context.active() });
  };
  return { log, shutdown: async () => { await provider?.forceFlush(); await provider?.shutdown(); } };
}
