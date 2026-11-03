// Simulated time. Every pipeline timestamp is simulated ms since epoch; `speed` real-to-simulated.
export interface Clock { now(): number; sleep(simMs: number): Promise<void>; speed: number }

export function createSimClock(opts: { simStart: number; speed: number; realStart?: number }): Clock {
  const realStart = opts.realStart ?? Date.now();
  return {
    speed: opts.speed,
    now: () => opts.simStart + (Date.now() - realStart) * opts.speed,
    sleep: (simMs) => new Promise((r) => setTimeout(r, Math.max(0, simMs / opts.speed))),
  };
}

export function createFakeClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  const waiters: { at: number; resolve: () => void }[] = [];
  return {
    speed: 1,
    now: () => t,
    sleep: (ms) => new Promise<void>((resolve) => { waiters.push({ at: t + ms, resolve }); }),
    advance(ms) {
      t += ms;
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].at <= t) { waiters[i].resolve(); waiters.splice(i, 1); }
    },
  };
}
