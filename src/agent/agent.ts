// Load-decision agent: a local model (Ollama) decides book / negotiate / ask / skip for one load and one truck.
// Two modes, compared in the evals (ml/agent):
//   tools    a real agent loop: the model calls get_load / get_truck / get_market_rate / get_deadhead, then answers
//   context  no tools: code fetches every fact first and pastes it into one prompt (one model call)
// Every run is one trace: agent span -> each model call (GenAI span: messages, output, tokens) -> each tool call.
import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { traceLlmCall } from '../obs/llm.ts';
import { POLICY_TEXT, type Decision, type Facts } from './policy.ts';

export type AgentMode = 'tools' | 'context';
export type AgentRun = { decision: Decision | null; error: string | null; modelCalls: number; toolCalls: string[]; inputTokens: number; outputTokens: number; latencyMs: number; traceId: string | null; steps: unknown[] };

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['book', 'negotiate', 'ask', 'skip'] },
    target_rate: { type: ['number', 'null'] },
    reasons: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['verdict', 'target_rate', 'reasons'],
};
const TOOLS = [
  { type: 'function', function: { name: 'get_load', description: 'The load: lane, equipment, posted rate (null = none posted), miles, weight, pickup date, broker comments.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_truck', description: "The truck: location, equipment, tarps, frozen-capable, max weight, max deadhead, minimum rate per mile.", parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_market_rate', description: "Typical market rate per mile for this load's lane and equipment.", parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_deadhead', description: 'Empty miles from the truck to the pickup.', parameters: { type: 'object', properties: {}, required: [] } } },
];
const SYSTEM = `You help a truck dispatcher decide about one load for one truck. Use only facts from your tools; never invent numbers.
${POLICY_TEXT}
Answer with JSON: {"verdict": "book"|"negotiate"|"ask"|"skip", "target_rate": number or null (dollars for the whole load), "reasons": up to 3 short reasons that quote the numbers you used}.`;

type Msg = { role: string; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string };
type OllamaReply = { model: string; message: Msg; prompt_eval_count?: number; eval_count?: number };

export async function runAgent(opts: { url: string; model: string; mode: AgentMode; facts: Facts; tracer: Tracer | null; sessionId?: string; metadata?: Record<string, string>; maxSteps?: number }): Promise<AgentRun> {
  const t0 = performance.now();
  const run: AgentRun = { decision: null, error: null, modelCalls: 0, toolCalls: [], inputTokens: 0, outputTokens: 0, latencyMs: 0, traceId: null, steps: [] };
  const toolResult = (name: string): unknown => {
    const f = opts.facts;
    if (name === 'get_load') return f.load;
    if (name === 'get_truck') return f.truck;
    if (name === 'get_market_rate') return { lane: `${f.load.origin_market} → ${f.load.dest}`, equipment: f.load.equipment, market_rate_per_mile: f.market_rate_per_mile };
    if (name === 'get_deadhead') return { from: f.truck.location, to: f.load.origin, deadhead_miles: f.deadhead_miles };
    return { error: `unknown tool ${name}` };
  };
  const chat = async (messages: Msg[], extra: { tools?: unknown[]; format?: unknown }) => {
    const r = await traceLlmCall(opts.tracer,
      { system: 'ollama', model: opts.model, operation: 'chat', input: { messages, tools: extra.tools ? extra.tools.map((t: any) => t.function.name) : undefined, response_format: extra.format }, params: { temperature: 0 }, sessionId: opts.sessionId, metadata: opts.metadata },
      async () => {
        const res = await fetch(`${opts.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: opts.model, stream: false, messages, options: { temperature: 0, num_ctx: 4096 }, ...(extra.tools ? { tools: extra.tools } : {}), ...(extra.format ? { format: extra.format } : {}) }) });
        if (!res.ok) throw new Error(`ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const body = (await res.json()) as OllamaReply;
        return { value: body, output: body.message, responseModel: body.model, inputTokens: body.prompt_eval_count ?? null, outputTokens: body.eval_count ?? null };
      });
    run.modelCalls++; run.inputTokens += r.inputTokens ?? 0; run.outputTokens += r.outputTokens ?? 0;
    run.steps.push({ type: 'model', ms: Math.round(r.latencyMs), message: r.value.message });
    return r.value.message;
  };
  const tool = (name: string) => {
    const out = toolResult(name);
    run.toolCalls.push(name);
    run.steps.push({ type: 'tool', name, output: out });
    if (opts.tracer) {
      const s = opts.tracer.startSpan(`execute_tool ${name}`, { attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name,
        'langfuse.observation.type': 'tool', 'langfuse.observation.input': '{}', 'langfuse.observation.output': JSON.stringify(out), ...(opts.sessionId ? { 'langfuse.session.id': opts.sessionId } : {}) } });
      s.end();
    }
    return out;
  };
  const parse = (content: string): Decision | null => {
    try {
      const d = JSON.parse(content);
      if (!['book', 'negotiate', 'ask', 'skip'].includes(d.verdict)) return null;
      return { verdict: d.verdict, target_rate: typeof d.target_rate === 'number' ? d.target_rate : null, reasons: Array.isArray(d.reasons) ? d.reasons.map(String).slice(0, 3) : [] };
    } catch { return null; }
  };

  const body = async () => {
    if (opts.mode === 'context') {
      const facts = Object.fromEntries(['get_load', 'get_truck', 'get_market_rate', 'get_deadhead'].map((n) => [n.replace('get_', ''), tool(n)]));
      const m = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: `Facts:\n${JSON.stringify(facts, null, 1)}\nDecide.` }], { format: DECISION_SCHEMA });
      run.decision = parse(m.content);
      return;
    }
    const messages: Msg[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Decide about this load for this truck. Call the tools you need first.' }];
    // Guards against the usual small-model loops: a repeated tool call gets "you already have this", and once every
    // fact is in, the model gets no more tools and must answer.
    const have = new Set<string>();
    for (let step = 0; step < (opts.maxSteps ?? 6) && have.size < TOOLS.length; step++) {
      const m = await chat(messages, { tools: TOOLS });
      messages.push({ role: 'assistant', content: m.content ?? '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) });
      if (!m.tool_calls?.length) break;
      for (const c of m.tool_calls) {
        const name = c.function.name;
        const content = have.has(name) ? JSON.stringify({ note: `you already called ${name}; its result is above. Do not call it again.` }) : JSON.stringify(tool(name));
        if (have.has(name)) run.toolCalls.push(`${name} (repeat)`);
        have.add(name);
        messages.push({ role: 'tool', tool_name: name, content });
      }
    }
    // Final answer in the required shape (the tool-calling turn may answer in prose).
    run.decision = parse(messages[messages.length - 1].content);
    if (!run.decision) {
      const m = await chat([...messages, { role: 'user', content: 'You have all the facts. Apply the policy step by step and give your decision as JSON only.' }], { format: DECISION_SCHEMA });
      run.decision = parse(m.content);
    }
  };

  const finish = () => { run.latencyMs = performance.now() - t0; if (!run.decision && !run.error) run.error = 'no valid decision'; };
  if (!opts.tracer) { try { await body(); } catch (e) { run.error = String(e); } finish(); return run; }
  return opts.tracer.startActiveSpan(`invoke_agent load-decision`, { attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'load-decision',
    'langfuse.observation.type': 'agent', 'langfuse.observation.input': JSON.stringify({ load_id: opts.facts.load.load_id, mode: opts.mode, model: opts.model }),
    'agent.mode': opts.mode, 'agent.model': opts.model, ...(opts.sessionId ? { 'langfuse.session.id': opts.sessionId } : {}) } }, async (span) => {
    run.traceId = span.spanContext().traceId;
    try { await body(); } catch (e) { run.error = String(e); span.recordException(e as Error); span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) }); }
    finish();
    span.setAttributes({ 'langfuse.observation.output': JSON.stringify(run.decision ?? { error: run.error }), 'agent.model_calls': run.modelCalls, 'agent.tool_calls': run.toolCalls.join(',') });
    span.end();
    return run;
  });
}
