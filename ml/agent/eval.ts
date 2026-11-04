// Evals for the load-decision agent: each model x mode on every case, graded against the policy's answer.
//   node ml/agent/eval.ts --ollama http://ollama:11434 --models qwen2.5:1.5b-instruct-q8_0,qwen2.5:3b-instruct --modes context,tools
// Graders (deterministic, no LLM judge):
//   verdict    same verdict as the policy
//   target     |target_rate - expected| <= $50 (not graded when the right answer is "skip")
//   grounded   every number in the reasons comes from a tool result or a value the policy derives from them
//   valid      the model produced a decision in the required shape
// Writes ml/agent/RESULTS.md (appends one table row per model x mode as it finishes) and ml/agent/runs.jsonl.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setupLlmTracing } from '../../src/obs/llm.ts';
import { runAgent, type AgentMode, type AgentRun } from '../../src/agent/agent.ts';
import type { Decision, Facts } from '../../src/agent/policy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: {
  ollama: { type: 'string', default: 'http://127.0.0.1:11434' }, models: { type: 'string', default: 'qwen2.5:1.5b-instruct-q8_0' },
  modes: { type: 'string', default: 'context,tools' }, cases: { type: 'string', default: join(here, 'cases.jsonl') }, limit: { type: 'string', default: '0' },
  otlp: { type: 'string', default: 'off' }, langfuse: { type: 'string', default: '' } } });
type Case = { id: string; facts: Facts; expected: Decision; traps: string[] };
let cases: Case[] = readFileSync(a.cases!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (Number(a.limit)) cases = cases.slice(0, Number(a.limit));
const tracing = setupLlmTracing({ endpoint: a.otlp === 'off' ? null : a.otlp!, serviceName: 'load-radar-agent-eval' });
const env = (k: string) => process.env[k] ?? (existsSync(join(here, '../../.env')) ? readFileSync(join(here, '../../.env'), 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] : undefined);
const runId = new Date().toISOString().replace(/[:.]/g, '-');

// Numbers the reasons may quote: tool facts, plus what the policy derives from them.
function allowedNumbers(f: Facts, e: Decision): number[] {
  const l = f.load, t = f.truck;
  const target = Math.max(f.market_rate_per_mile, t.min_rate_per_mile ?? 0);
  const xs = [l.rate, l.miles, l.weight_lbs, f.market_rate_per_mile, f.deadhead_miles, t.max_weight_lbs, t.max_deadhead_mi, t.min_rate_per_mile, target, 0.85 * target, 85, 100,
    l.rate !== null ? l.rate / l.miles : null, e.target_rate, target * l.miles];
  for (const m of `${l.comments} ${l.pickup_date} ${l.equipment_detail}`.matchAll(/\d+(?:\.\d+)?/g)) xs.push(Number(m[0]));
  return xs.filter((x): x is number => typeof x === 'number');
}
function grounded(reasons: string[], allowed: number[]): { ok: boolean; invented: number[] } {
  const invented: number[] = [];
  for (const m of reasons.join(' ').replace(/,(\d{3})/g, '$1').matchAll(/\d+(?:\.\d+)?/g)) {
    const x = Number(m[0]);
    const ok = allowed.some((y) => Math.abs(x - y) <= Math.max(0.011, Math.abs(y) * 0.01) || Math.abs(x - y * 100) <= 1);   // rounding, or a percentage
    if (!ok) invented.push(x);
  }
  return { ok: invented.length === 0, invented };
}
function grade(c: Case, r: AgentRun) {
  const d = r.decision, e = c.expected;
  const verdict = !!d && d.verdict === e.verdict;
  const target = !!d && (e.verdict === 'skip' || (d.target_rate !== null && e.target_rate !== null && Math.abs(d.target_rate - e.target_rate) <= 50));
  const g = d ? grounded(d.reasons, allowedNumbers(c.facts, e)) : { ok: false, invented: [] };
  return { verdict, target, grounded: g.ok, invented: g.invented, valid: !!d };
}
async function score(traceId: string | null, name: string, value: number) {
  const pk = env('LANGFUSE_PUBLIC_KEY'), sk = env('LANGFUSE_SECRET_KEY');
  if (!a.langfuse || !traceId || !pk || !sk) return;
  await fetch(`${a.langfuse}/api/public/scores`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}` },
    body: JSON.stringify({ traceId, name, value, dataType: 'NUMERIC' }) }).catch(() => {});
}

const results = join(here, 'RESULTS.md');
if (!existsSync(results) || !readFileSync(results, 'utf8').includes('| Model | Mode |')) {
  writeFileSync(results, `# Load-decision agent: eval results

Cases: \`ml/agent/cases.jsonl\` (${cases.length} loads from the world model, seed 21; 6 per verdict; ${cases.filter((c) => c.traps.length).length} with comment traps).
Answer key: \`src/agent/policy.ts\`. Graders: verdict, target rate within $50, grounded (no invented numbers), valid JSON.
Hardware: the Linux server's CPU (Ryzen 7 3700U, no GPU), Ollama, temperature 0. Background in [ML.md](../../ML.md).

| Model | Mode | Verdict | Target rate | Grounded | Valid | Comment traps | Model calls / case | Latency p50 / p95 | Tokens in / out per case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
`);
}
const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(1, d))}%`;
const q = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

for (const model of a.models!.split(',')) for (const mode of a.modes!.split(',') as AgentMode[]) {
  const rows: { c: Case; r: AgentRun; g: ReturnType<typeof grade> }[] = [];
  for (const c of cases) {
    const r = await runAgent({ url: a.ollama!, model, mode, facts: c.facts, tracer: tracing.tracer, sessionId: `agent-eval-${runId}-${model}-${mode}`, metadata: { case: c.id } });
    const g = grade(c, r);
    rows.push({ c, r, g });
    appendFileSync(join(here, 'runs.jsonl'), JSON.stringify({ runId, model, mode, case: c.id, expected: c.expected, decision: r.decision, error: r.error, grade: g, modelCalls: r.modelCalls, tools: r.toolCalls, ms: Math.round(r.latencyMs), tokens: [r.inputTokens, r.outputTokens], traceId: r.traceId }) + '\n');
    await score(r.traceId, 'agent_verdict_correct', g.verdict ? 1 : 0);
    await score(r.traceId, 'agent_grounded', g.grounded ? 1 : 0);
    console.error(`${model} ${mode} ${c.id}: ${r.decision?.verdict ?? r.error} (want ${c.expected.verdict}) ${g.verdict ? 'ok' : 'WRONG'}${g.invented.length ? ` invented ${g.invented}` : ''} ${(r.latencyMs / 1000).toFixed(1)}s`);
  }
  const n = rows.length, traps = rows.filter((x) => x.c.traps.length);
  const ms = rows.map((x) => x.r.latencyMs / 1000);
  const line = `| ${model} | ${mode} | **${pct(rows.filter((x) => x.g.verdict).length, n)}** | ${pct(rows.filter((x) => x.g.target).length, n)} | ${pct(rows.filter((x) => x.g.grounded).length, n)} | ${pct(rows.filter((x) => x.g.valid).length, n)} | ${pct(traps.filter((x) => x.g.verdict).length, traps.length)} | ${(rows.reduce((s, x) => s + x.r.modelCalls, 0) / n).toFixed(1)} | ${q(ms, 0.5).toFixed(1)} / ${q(ms, 0.95).toFixed(1)} s | ${Math.round(rows.reduce((s, x) => s + x.r.inputTokens, 0) / n)} / ${Math.round(rows.reduce((s, x) => s + x.r.outputTokens, 0) / n)} |\n`;
  appendFileSync(results, line);
  console.log(line.trim());
}
await tracing.shutdown();
