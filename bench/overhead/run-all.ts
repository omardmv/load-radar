// Runs every mode several times, each in a fresh process, rotating the order to cancel warm-up and thermal bias.
//   node bench/overhead/run-all.ts --modes none,metrics,trace1,trace100 --reps 5 --rate 5000 --seconds 30 --data /tmp/lr/v6 --out bench/overhead/results/fixed-rate.jsonl
// Needs the sink running: node bench/overhead/sink.ts 4318
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce<[string, string][]>((a, x, i, all) => (x.startsWith('--') && a.push([x.slice(2), all[i + 1]]), a), []));
const modes = (args.modes ?? 'none,metrics,trace1,trace100').split(',');
const reps = Number(args.reps ?? 5);
const out = args.out ?? 'bench/overhead/results/run.jsonl';
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(dirname(out), { recursive: true });
const pass = ['rate', 'seconds', 'warmup', 'data', 'shared', 'queue'].flatMap((k) => (args[k] !== undefined ? [`--${k}`, args[k]] : []));

for (let r = 0; r < reps; r++) {
  const order = modes.map((_, k) => modes[(k + r) % modes.length]);   // rotate
  for (const mode of order) {
    try { execFileSync('curl', ['-s', '-X', 'POST', 'http://127.0.0.1:4318/reset']); } catch {}
    const line = execFileSync('node', [join(here, 'run.ts'), '--mode', mode, ...pass], { encoding: 'utf8' }).trim().split('\n').pop()!;
    appendFileSync(out, JSON.stringify({ rep: r + 1, ...JSON.parse(line) }) + '\n');
    console.log(`rep ${r + 1} ${mode.padEnd(9)} ${line}`);
  }
}

// summary: median and spread per mode, overhead vs 'none'
const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const base = med(rows.filter((x) => x.mode === 'none').map((x) => x.cpuUsPerPosting));
console.log('\nmode       runs  CPU µs/posting (median, min–max)   overhead vs none   postings/s   dropped spans   exported spans');
for (const m of modes) {
  const xs = rows.filter((x) => x.mode === m);
  const c = xs.map((x) => x.cpuUsPerPosting);
  console.log(`${m.padEnd(10)} ${String(xs.length).padStart(4)}  ${med(c).toFixed(1).padStart(6)} (${Math.min(...c).toFixed(1)}–${Math.max(...c).toFixed(1)})`.padEnd(48) +
    `${(base ? ((med(c) / base - 1) * 100).toFixed(1) + '%' : '-').padStart(10)}   ${String(med(xs.map((x) => x.postingsPerSec))).padStart(10)}   ${String(med(xs.map((x) => x.droppedSpans))).padStart(13)}   ${String(med(xs.map((x) => x.sinkSpans))).padStart(14)}`);
}
