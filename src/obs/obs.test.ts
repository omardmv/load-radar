import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupObs } from './obs.ts';

test('lite counters reach prom-client after flush; timings are sampled', async () => {
  const obs = setupObs({ sampleRate: 0, otlpEndpoint: null, metricsPort: null, timeEvery: 4 });
  for (let i = 0; i < 8; i++) { const t = obs.begin(); obs.stage('normalize', t, () => 1); obs.finish(t, { board: 'dat' }); }
  obs.dedup('new');
  let text = await obs.metricsText();
  assert.doesNotMatch(text, /stage_items_total\{stage="normalize"\} \d/);   // nothing reaches prom-client until flush
  obs.flush();
  text = await obs.metricsText();
  assert.match(text, /stage_items_total\{stage="normalize"\} 8/);
  assert.match(text, /dedup_total\{result="new"\} 1/);
  assert.match(text, /stage_duration_seconds_count\{stage="normalize"\} 2/);   // 1 in 4 timed
  await obs.close();
});

test('sampled postings and failures become one span each', async () => {
  let spans = 0;
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const j = JSON.parse(Buffer.concat(chunks).toString());
      for (const rs of j.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) spans += ss.spans.length;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const obs = setupObs({ sampleRate: 1, otlpEndpoint: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/traces`, metricsPort: null });
  for (let i = 0; i < 3; i++) { const t = obs.begin(); obs.stage('normalize', t, () => 1); obs.stage('dedup', t, () => 1); obs.finish(t, { board: 'dat' }); }
  await obs.close();
  srv.close();
  assert.equal(spans, 3);
});
