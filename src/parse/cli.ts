// Try the parser from the terminal:
//   node src/parse/cli.ts "reefer outta fresno 3.40+ no more than 100 deadhead"
//   node src/parse/cli.ts --mode hybrid --gliner http://127.0.0.1:7100 "need loads out of dallas"
//   add --otlp http://127.0.0.1:4318/v1/traces to see each model call in Langfuse / Jaeger
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPlaceIndex } from './places.ts';
import { parseSearch, type ParseMode } from './parse.ts';
import { createGlinerExtractor } from './gliner.ts';
import { createOllamaExtractor } from './ollama.ts';
import { describe } from './normalize.ts';
import { setupLlmTracing } from '../obs/llm.ts';

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
  mode: { type: 'string', default: 'rules' }, gliner: { type: 'string', default: '' }, ollama: { type: 'string', default: '' },
  'ollama-model': { type: 'string', default: 'qwen2.5:1.5b-instruct-q8_0' }, otlp: { type: 'string', default: '' } } });
const tracing = setupLlmTracing({ endpoint: a.otlp || null, serviceName: 'load-radar-parser' });
const places = createPlaceIndex(join(dirname(fileURLToPath(import.meta.url)), '../../sim/data'));
const extractor = a.gliner ? createGlinerExtractor(a.gliner, { tracer: tracing.tracer }) : a.ollama ? createOllamaExtractor({ url: a.ollama, model: a['ollama-model']!, tracer: tracing.tracer }) : undefined;
const r = await parseSearch(positionals.join(' '), { places, mode: a.mode as ParseMode, extractor, onModelCall: (c) => console.log(`model call: ${c.model} ${c.latencyMs.toFixed(0)} ms trace ${c.traceId ?? '(tracing off)'}`), context: { sessionId: 'cli' } });
console.log(describe(r));
for (const q of r.questions) console.log(`? ${q}`);
console.log(JSON.stringify(r.sources));
await tracing.shutdown();
