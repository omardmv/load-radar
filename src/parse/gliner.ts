// Client for ml/parser/service.py (GLiNER2, local CPU). Cold path only: ~50 ms per call.
// Every call is one GenAI span (src/obs/llm.ts): input = the text and the schema the model is asked to fill.
import type { Tracer } from '@opentelemetry/api';
import type { Equip } from '../shared/types.ts';
import { traceLlmCall } from '../obs/llm.ts';
import type { Extractor, RawFields } from './types.ts';

type Span = { text: string; confidence: number };
type GlinerResponse = { model: string; result: { entities: Record<string, Span[] | undefined>; equipment?: { label: string; confidence: number } } };

// Mirrors the schema in ml/parser/service.py, so the trace shows what the model was asked.
const SCHEMA = {
  entities: {
    origin_city: 'city or town where the empty truck is',
    destination: "destination city, state, region or 'anywhere'",
    rate_per_mile: 'minimum pay in dollars per mile',
    deadhead_miles: 'radius or deadhead distance in miles',
  },
  classification: { equipment: ['van', 'reefer', 'flatbed', 'unspecified'] },
};

export function createGlinerExtractor(url: string, opts: { tracer?: Tracer | null; model?: string; minConfidence?: number } = {}): Extractor {
  const model = opts.model ?? 'fastino/gliner2-base-v1';
  const minConfidence = opts.minConfidence ?? 0.6;
  return async (text, ctx) => {
    const r = await traceLlmCall(opts.tracer ?? null,
      { system: 'gliner2', model, operation: 'extract', input: { text, schema: SCHEMA }, params: { min_confidence: minConfidence }, sessionId: ctx?.sessionId, metadata: ctx?.metadata },
      async () => {
        const res = await fetch(`${url}/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        if (!res.ok) throw new Error(`gliner service answered ${res.status}`);
        const body = (await res.json()) as GlinerResponse;
        return { value: body.result, output: body.result, responseModel: body.model };
      });
    const result = r.value;
    const first = (k: string) => result.entities[k]?.[0]?.text;
    const fields: RawFields = {};
    if (first('origin_city')) fields.originText = first('origin_city');
    if (first('destination')) fields.destText = first('destination');
    if (first('rate_per_mile')) fields.rateText = first('rate_per_mile');
    if (first('deadhead_miles')) fields.deadheadText = first('deadhead_miles');
    const eq = result.equipment;
    fields.equipment = eq && eq.label !== 'unspecified' && eq.confidence >= minConfidence ? (eq.label as Equip) : 'unspecified';
    return { fields, call: { model: `gliner2:${model}`, latencyMs: r.latencyMs, promptTokens: null, outputTokens: null, output: result, traceId: r.traceId, observationId: r.observationId } };
  };
}
