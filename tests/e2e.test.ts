import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('full run on a small generated dataset: alerts delivered, no bans', { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-e2e-'));
  const gen = spawnSync(process.execPath, [join(root, 'sim/gen.ts'), '--loads', '3000', '--users', '100', '--hours', '2', '--out', dir], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const run = spawnSync(process.execPath, [join(root, 'scripts/run.ts'), '--data', dir, '--speed', '60', '--minutes', '1.5', '--port-base', '17001', '--metrics-port', '19464'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split('\n').find((l) => l.startsWith('RUN_RESULT '))!;
  const result = JSON.parse(line.slice(11));
  console.log(JSON.stringify(result.score));
  assert.ok(result.score.expected > 0, 'some alerts were expected');
  assert.ok(result.score.delivered > 0, 'some alerts were delivered');
  assert.equal(result.boards.bannedLogins, 0, 'no login was banned');
  assert.ok(result.score.missRate < 0.5, `miss rate ${result.score.missRate}`);
});
