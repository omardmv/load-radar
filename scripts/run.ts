// Launch boards-sim + telegram-sim + engine on one simulated clock, run for --minutes (real), then score.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { score } from '../scorer/score.ts';

const { values: a } = parseArgs({ options: {
  data: { type: 'string', default: 'out' }, speed: { type: 'string', default: '30' }, minutes: { type: 'string', default: '5' },
  budget: { type: 'string', default: '60' }, connections: { type: 'string', default: '64' }, users: { type: 'string', default: '0' },
  otlp: { type: 'string', default: 'off' }, sample: { type: 'string', default: '0.01' }, 'port-base': { type: 'string', default: '7001' },
  'metrics-port': { type: 'string', default: '9464' } } });
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(a.data!, 'meta.json'), 'utf8'));
const speed = Number(a.speed), minutes = Number(a.minutes), base = Number(a['port-base']);
const simStart = Date.parse(meta.start);
const realStart = Date.now() + 3_000;                      // children start on the same simulated clock
const runDir = join(a.data!, 'run');
mkdirSync(runDir, { recursive: true });
const deliveries = join(runDir, 'deliveries.ndjson');
rmSync(deliveries, { force: true });
const clockArgs = ['--sim-start', new Date(simStart).toISOString(), '--real-start', String(realStart), '--speed', String(speed)];
const boardsUrl = `http://127.0.0.1:${base}`, telegramUrl = `http://127.0.0.1:${base + 1}`;
const node = (file: string, args: string[]): ChildProcess => spawn(process.execPath, [join(root, file), ...args], { stdio: ['ignore', 'pipe', 'inherit'] });

const boards = node('sims/boards-sim.ts', ['--data', a.data!, '--port', String(base), '--budget', a.budget!, ...clockArgs]);
const telegram = node('sims/telegram-sim.ts', ['--port', String(base + 1), '--log', deliveries, ...clockArgs]);
const engine = node('src/engine.ts', ['--data', a.data!, '--boards', boardsUrl, '--telegram', telegramUrl, '--budget', a.budget!, '--connections', a.connections!,
  '--users', a.users!, '--otlp', a.otlp!, '--sample', a.sample!, '--metrics-port', a['metrics-port']!, ...clockArgs]);
let engineSummary: unknown = null;
engine.stdout!.on('data', (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.startsWith('ENGINE_SUMMARY ')) engineSummary = JSON.parse(l.slice(15)); else if (l.trim()) console.error(`[engine] ${l}`); });
boards.stdout!.on('data', (b: Buffer) => console.error(`[boards] ${b.toString().trim()}`));
telegram.stdout!.on('data', (b: Buffer) => console.error(`[telegram] ${b.toString().trim()}`));

await new Promise((r) => setTimeout(r, 3_000 + minutes * 60_000));
const boardStats = await fetch(`${boardsUrl}/stats`).then((r) => r.json()).catch(() => null);
const exited = new Promise((r) => engine.on('exit', r));
engine.kill('SIGTERM');
await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
boards.kill('SIGTERM');
telegram.kill('SIGTERM');

const windowEnd = simStart + minutes * 60_000 * speed;
const report = score({ truthFile: join(a.data!, 'truth.ndjson'), searchesFile: join(a.data!, 'searches.ndjson'), deliveriesFile: deliveries, windowStart: simStart, windowEnd, settleMs: 10 * 60_000 });
const result = { config: { speed, minutes, simHours: (minutes * speed) / 60, budget: Number(a.budget), connections: Number(a.connections) }, score: report, boards: boardStats, engine: engineSummary };
writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 2));
console.log(`RUN_RESULT ${JSON.stringify(result)}`);
