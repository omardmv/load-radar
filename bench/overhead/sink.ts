// Stand-in for the OTel Collector: accepts OTLP/HTTP JSON traces, counts spans, discards them.
// Runs in its own process so its CPU is not counted against the engine.
//   node bench/overhead/sink.ts 4318
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4318);
let spans = 0, requests = 0, bytes = 0;
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') { res.end(JSON.stringify({ spans, requests, bytes })); return; }
  if (req.method === 'POST' && req.url === '/reset') { spans = requests = bytes = 0; res.end('{}'); return; }
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks); requests++; bytes += body.length;
    try {
      const j = JSON.parse(body.toString());
      for (const rs of j.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) spans += ss.spans?.length ?? 0;
    } catch { /* protobuf or garbage: count bytes only */ }
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log(`sink on :${port}`));
