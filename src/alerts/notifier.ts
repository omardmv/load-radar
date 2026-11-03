import type { Clock } from '../shared/clock.ts';
import { createTokenBucket, type TokenBucket } from '../shared/bucket.ts';
import type { Alert } from '../shared/types.ts';
import type { AlertQueue } from './alert-queue.ts';

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

// Sends alerts within Telegram's limits (LLD 6.9): per bot and per chat token buckets; a chat with several
// waiting alerts gets them merged into one digest message.
export function createNotifier(opts: {
  clock: Clock; queue: AlertQueue; bots: number; perBotPerSec: number; perChatPerSec: number; maxDigest: number;
  send(botId: number, chatId: string, alerts: Alert[]): Promise<{ ok: boolean; retryAfterSec?: number }>;
  onSent(alerts: Alert[], at: number): void;
}) {
  const botBuckets: TokenBucket[] = Array.from({ length: opts.bots }, () => createTokenBucket(opts.perBotPerSec * 60, opts.perBotPerSec, opts.clock));
  const botPausedUntil: number[] = Array(opts.bots).fill(0);
  const chatBuckets = new Map<string, TokenBucket>();
  const held = new Map<string, Alert[]>();
  const chatBucket = (chat: string) => {
    let b = chatBuckets.get(chat);
    if (!b) { b = createTokenBucket(opts.perChatPerSec * 60, 1, opts.clock); chatBuckets.set(chat, b); }
    return b;
  };
  const heldCount = () => { let n = 0; for (const l of held.values()) n += l.length; return n; };

  async function tick(): Promise<number> {
    for (const a of opts.queue.take(1000).alerts) {
      const l = held.get(a.userId);
      if (l) l.push(a); else held.set(a.userId, [a]);
    }
    const now = opts.clock.now();
    const sends: Promise<void>[] = [];
    for (const [chat, list] of held) {
      const bot = hash(chat) % opts.bots;
      if (botPausedUntil[bot] > now) continue;
      const cb = chatBucket(chat);
      if (cb.nextTokenAt() > now || botBuckets[bot].nextTokenAt() > now) continue;
      cb.take(); botBuckets[bot].take();
      const batch = list.splice(0, opts.maxDigest);
      if (!list.length) held.delete(chat);
      sends.push(opts.send(bot, chat, batch).then((r) => {
        if (r.ok) { opts.onSent(batch, opts.clock.now()); return; }
        botPausedUntil[bot] = opts.clock.now() + (r.retryAfterSec ?? 1) * 1000;
        const back = held.get(chat);
        if (back) back.unshift(...batch); else held.set(chat, batch);
      }));
    }
    await Promise.all(sends);
    return sends.length;
  }

  return {
    tick,
    held: heldCount,
    async run(): Promise<never> {
      for (;;) { await tick(); await opts.clock.sleep(Math.max(50, 5 * opts.clock.speed)); }
    },
  };
}
