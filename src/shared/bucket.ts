import type { Clock } from './clock.ts';

export interface TokenBucket { take(): boolean; nextTokenAt(): number; setRatePerMin(r: number): void; ratePerMin(): number }

// Token bucket on simulated time: `ratePerMin` tokens per simulated minute, at most `burst` saved up.
export function createTokenBucket(ratePerMin: number, burst: number, clock: Clock): TokenBucket {
  let rate = ratePerMin;
  let tokens = burst;
  let last = clock.now();
  const refill = () => { const now = clock.now(); tokens = Math.min(burst, tokens + ((now - last) / 60_000) * rate); last = now; };
  return {
    take() { refill(); if (tokens >= 1) { tokens -= 1; return true; } return false; },
    nextTokenAt() { refill(); return tokens >= 1 ? clock.now() : clock.now() + Math.ceil(((1 - tokens) / rate) * 60_000); },
    setRatePerMin(r) { refill(); rate = r; },
    ratePerMin: () => rate,
  };
}
