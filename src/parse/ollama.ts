// Local LLM contender: Ollama chat with a JSON schema, so the output always has the right shape.
// Every call is one GenAI span (src/obs/llm.ts): input = the exact messages and schema sent; tokens from Ollama.
import type { Tracer } from '@opentelemetry/api';
import { traceLlmCall } from '../obs/llm.ts';
import type { Extractor, RawFields } from './types.ts';

const SCHEMA = {
  type: 'object',
  properties: {
    equipment: { type: 'string', enum: ['van', 'reefer', 'flatbed', 'unspecified'] },
    origin: { type: ['string', 'null'] },
    destination: { type: ['string', 'null'] },
    min_rate_per_mile: { type: ['number', 'null'] },
    deadhead_miles: { type: ['number', 'null'] },
  },
  required: ['equipment', 'origin', 'destination', 'min_rate_per_mile', 'deadhead_miles'],
};
const SYSTEM = [
  'Extract a truck dispatcher\'s load search.',
  'equipment: van, reefer or flatbed; "unspecified" if not stated (step deck counts as flatbed).',
  'origin: where the empty truck is, copied as written (city and state if given).',
  'destination: copied as written (a city, state codes, a region, or "anywhere"); null if not stated.',
  'min_rate_per_mile: the minimum pay per mile as a number; null if not stated.',
  'deadhead_miles: the radius or deadhead in miles; null if not stated.',
].join('\n');
const TEMPERATURE = 0;

type OllamaResponse = { model: string; message: { content: string }; prompt_eval_count?: number; eval_count?: number };

export function createOllamaExtractor(opts: { url: string; model: string; tracer?: Tracer | null }): Extractor {
  return async (text, ctx) => {
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }];
    const r = await traceLlmCall(opts.tracer ?? null,
      { system: 'ollama', model: opts.model, operation: 'chat', input: { messages, response_format: SCHEMA }, params: { temperature: TEMPERATURE }, sessionId: ctx?.sessionId, metadata: ctx?.metadata },
      async () => {
        const res = await fetch(`${opts.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: opts.model, stream: false, format: SCHEMA, options: { temperature: TEMPERATURE }, messages }) });
        if (!res.ok) throw new Error(`ollama answered ${res.status}`);
        const body = (await res.json()) as OllamaResponse;
        let out: Record<string, unknown> = {};
        try { out = JSON.parse(body.message.content); } catch { out = { unparsable: body.message.content }; }
        return { value: out, output: body.message.content, responseModel: body.model, inputTokens: body.prompt_eval_count ?? null, outputTokens: body.eval_count ?? null };
      });
    const out = r.value;
    const fields: RawFields = {};
    if (typeof out.equipment === 'string' && ['van', 'reefer', 'flatbed', 'unspecified'].includes(out.equipment)) fields.equipment = out.equipment as RawFields['equipment'];
    if (typeof out.origin === 'string' && out.origin.trim()) fields.originText = out.origin;
    if (typeof out.destination === 'string' && out.destination.trim()) fields.destText = out.destination;
    if (typeof out.min_rate_per_mile === 'number') fields.rateText = String(out.min_rate_per_mile);
    if (typeof out.deadhead_miles === 'number') fields.deadheadText = String(out.deadhead_miles);
    return { fields, call: { model: `ollama:${opts.model}`, latencyMs: r.latencyMs, promptTokens: r.inputTokens ?? null, outputTokens: r.outputTokens ?? null, output: out, traceId: r.traceId, observationId: r.observationId } };
  };
}
