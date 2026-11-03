// Compares search-parser contenders on ml/parser/eval.jsonl. Writes RESULTS.md and logs every model call.
//   ml/.venv/bin/python ml/parser/service.py 7100 &      (for gliner / hybrid)
//   node ml/parser/eval.ts --contenders rules,gliner,hybrid,qwen
// With the observability stack up, every model call is a GenAI span (Langfuse + Jaeger + Prometheus) and each
// scored example is attached to its call in Langfuse as `eval_all_correct` / `eval_fields_correct`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPlaceIndex } from '../../src/parse/places.ts';
import { parseSearch, type ParseMode } from '../../src/parse/parse.ts';
import { createGlinerExtractor } from '../../src/parse/gliner.ts';
import { createOllamaExtractor } from '../../src/parse/ollama.ts';
import type { Extractor, ModelCall } from '../../src/parse/types.ts';
import { setupLlmTracing } from '../../src/obs/llm.ts';
import { FIELDS, scoreExample, type EvalExample } from './score.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: {
  contenders: { type: 'string', default: 'rules,gliner,hybrid,qwen' }, gliner: { type: 'string', default: 'http://127.0.0.1:7100' },
  ollama: { type: 'string', default: 'http://127.0.0.1:11434' }, 'ollama-model': { type: 'string', default: 'qwen2.5:1.5b-instruct-q8_0' },
  otlp: { type: 'string', default: 'http://127.0.0.1:4318/v1/traces' }, langfuse: { type: 'string', default: 'http://127.0.0.1:3001' } } });
const tracing = setupLlmTracing({ endpoint: a.otlp === 'off' ? null : a.otlp!, serviceName: 'load-radar-parser-eval' });
const runId = new Date().toISOString().replace(/[:.]/g, '-');

// Langfuse API keys for posting scores: from the environment, else from the project's .env file.
const env = (k: string) => process.env[k] ?? (existsSync(join(here, '../../.env')) ? readFileSync(join(here, '../../.env'), 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] : undefined);
const lfAuth = env('LANGFUSE_PUBLIC_KEY') && env('LANGFUSE_SECRET_KEY') ? `Basic ${Buffer.from(`${env('LANGFUSE_PUBLIC_KEY')}:${env('LANGFUSE_SECRET_KEY')}`).toString('base64')}` : null;
const scoreStats = { posted: 0, failed: 0, lastError: '' };
async function postScore(body: Record<string, unknown>) {
  if (!lfAuth || a.otlp === 'off') return;
  const res = await fetch(`${a.langfuse}/api/public/scores`, { method: 'POST', headers: { authorization: lfAuth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch((e) => ({ ok: false, text: async () => String(e) }));
  if (res.ok) scoreStats.posted++; else { scoreStats.failed++; scoreStats.lastError = (await res.text()).slice(0, 200); }
}
const examples: EvalExample[] = readFileSync(join(here, 'eval.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const places = createPlaceIndex(join(here, '../../sim/data'));
const gliner = createGlinerExtractor(a.gliner!, { tracer: tracing.tracer });
const qwen = createOllamaExtractor({ url: a.ollama!, model: a['ollama-model']!, tracer: tracing.tracer });
const CONTENDERS: Record<string, { mode: ParseMode; extractor?: Extractor; label: string }> = {
  rules: { mode: 'rules', label: 'Rules only' },
  gliner: { mode: 'model', extractor: gliner, label: 'GLiNER2 only' },
  hybrid: { mode: 'hybrid', extractor: gliner, label: 'Hybrid: rules + GLiNER2' },
  qwen: { mode: 'model', extractor: qwen, label: `Qwen 2.5 1.5B only (Ollama, JSON schema)` },
  'hybrid-qwen': { mode: 'hybrid', extractor: qwen, label: 'Hybrid: rules + Qwen' },
};
const callsFile = join(here, 'calls.jsonl');
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const q = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

const rows: string[] = [];
const failures: string[] = [];
for (const key of a.contenders!.split(',')) {
  const c = CONTENDERS[key];
  if (!c) throw new Error(`unknown contender ${key}`);
  if (c.extractor) await c.extractor('warm up', { sessionId: `eval-${runId}-warmup` });   // first call loads the model; not measured
  const ok: Record<string, number> = Object.fromEntries([...FIELDS, 'all', 'messyAll'].map((f) => [f, 0]));
  const latency: number[] = [];
  let calls = 0, tokens = 0;
  for (const e of examples) {
    const t0 = performance.now();
    let call: ModelCall | null = null;
    const r = await parseSearch(e.text, { places, mode: c.mode, extractor: c.extractor, context: { sessionId: `eval-${runId}-${key}`, metadata: { contender: key, example_kind: e.kind } }, onModelCall: (m: ModelCall) => {
      call = m;
      calls++;
      tokens += (m.promptTokens ?? 0) + (m.outputTokens ?? 0);
      appendFileSync(callsFile, JSON.stringify({ ts: new Date().toISOString(), contender: key, text: e.text, ...m }) + '\n');
    } });
    latency.push(performance.now() - t0);
    const s = scoreExample(e, r);
    for (const f of [...FIELDS, 'all'] as const) if (s[f]) ok[f]++;
    if (s.all && e.kind === 'messy') ok.messyAll++;
    const traced = call as ModelCall | null;
    if (traced?.traceId) {
      const wrong = FIELDS.filter((f) => !s[f]);
      await postScore({ traceId: traced.traceId, observationId: traced.observationId, name: 'eval_all_correct', value: s.all ? 1 : 0, dataType: 'NUMERIC', comment: wrong.length ? `wrong: ${wrong.join(', ')}` : 'all correct' });
      await postScore({ traceId: traced.traceId, observationId: traced.observationId, name: 'eval_fields_correct', value: FIELDS.filter((f) => s[f]).length / FIELDS.length, dataType: 'NUMERIC' });
    }
    if (!s.all && key === 'hybrid') failures.push(`- \`${e.text}\` — wrong: ${FIELDS.filter((f) => !s[f]).join(', ')}`);
  }
  const n = examples.length, messy = examples.filter((e) => e.kind === 'messy').length;
  rows.push(`| ${c.label} | ${FIELDS.map((f) => pct(ok[f], n)).join(' | ')} | **${pct(ok.all, n)}** | ${pct(ok.messyAll, messy)} | ${calls} | ${q(latency, 0.5).toFixed(1)} / ${q(latency, 0.95).toFixed(1)} ms | ${tokens || '—'} |`);
  console.log(rows[rows.length - 1]);
}

writeFileSync(join(here, 'RESULTS.md'), `# Search parser: results

Generated by \`node ml/parser/eval.ts --contenders ${a.contenders}\` on ${new Date().toISOString().slice(0, 10)}, on a MacBook CPU.
Eval set: \`eval.jsonl\`, ${examples.length} searches (${examples.filter((e) => e.kind === 'template').length} generator templates, ${examples.filter((e) => e.kind === 'messy').length} hand-written messy ones).
Every model call is a GenAI span: in Langfuse (http://localhost:3001, session \`eval-${runId}-<contender>\`, with \`eval_all_correct\` scores), in Jaeger, and as \`llm_calls_total\` / \`llm_duration_*\` in Prometheus. A plain copy is in \`calls.jsonl\`.

A field counts as correct only after normalization (places, states, regions, numbers, defaults). "Asks when unsure" means the parser asked a question exactly when the example expects one.

| Contender | Equipment | Origin | Destination | Rate floor | Deadhead | Asks when unsure | All correct | All correct (messy) | Model calls | Latency p50 / p95 | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Where the hybrid parser is still wrong

${failures.join('\n') || 'Nothing: every example correct.'}
`);
await tracing.shutdown();
console.log(`Langfuse scores: ${scoreStats.posted} posted, ${scoreStats.failed} failed${scoreStats.lastError ? ` (${scoreStats.lastError})` : ''}`);
