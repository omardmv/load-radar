// Simulated Telegram Bot API (LLD 5.3): ~30 msg/s per bot, ~1 msg/s per chat, on the simulated clock.
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSimClock, type Clock } from '../src/shared/clock.ts';
import { createTokenBucket, type TokenBucket } from '../src/shared/bucket.ts';

export type Delivery = { botId: string; chatId: string; at: number; loads: { loadKey: string; canonicalId: string; postedAt: number }[] };

export function createTelegramHandler(opts: { clock: Clock; perBotPerSec: number; perChatPerSec: number; onDelivered(d: Delivery): void }) {
  const bots = new Map<string, TokenBucket>();
  const chats = new Map<string, TokenBucket>();
  const stats = { delivered: 0, limited: 0 };
  const bucket = (m: Map<string, TokenBucket>, k: string, perSec: number, burst: number) => {
    let b = m.get(k);
    if (!b) { b = createTokenBucket(perSec * 60, burst, opts.clock); m.set(k, b); }
    return b;
  };
  const reply = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  return Object.assign((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/stats') { reply(res, 200, stats); return; }
    const m = /^\/bot([^/]+)\/sendMessage$/.exec(req.url ?? '');
    if (!m || req.method !== 'POST') { reply(res, 404, { ok: false }); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const now = opts.clock.now();
      const bot = bucket(bots, m[1], opts.perBotPerSec, opts.perBotPerSec);
      const chat = bucket(chats, String(body.chat_id), opts.perChatPerSec, 1);
      if (bot.nextTokenAt() > now || chat.nextTokenAt() > now) {
        stats.limited++;
        const wait = Math.max(bot.nextTokenAt(), chat.nextTokenAt()) - now;
        reply(res, 429, { ok: false, error_code: 429, parameters: { retry_after: Math.max(1, Math.ceil(wait / 1000)) } });
        return;
      }
      bot.take(); chat.take();
      stats.delivered++;
      opts.onDelivered({ botId: m[1], chatId: String(body.chat_id), at: now, loads: body.meta?.loads ?? [] });
      reply(res, 200, { ok: true });
    });
  }, { stats });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { port: { type: 'string', default: '7002' }, log: { type: 'string', default: 'deliveries.ndjson' }, 'sim-start': { type: 'string' }, 'real-start': { type: 'string' }, speed: { type: 'string', default: '1' } } });
  const clock = createSimClock({ simStart: Date.parse(a['sim-start']!), realStart: Number(a['real-start']), speed: Number(a.speed) });
  const h = createTelegramHandler({ clock, perBotPerSec: 30, perChatPerSec: 1, onDelivered: (d) => appendFileSync(a.log!, JSON.stringify(d) + '\n') });
  createServer(h).listen(Number(a.port), '127.0.0.1', () => console.log(`telegram-sim on :${a.port}`));
}
