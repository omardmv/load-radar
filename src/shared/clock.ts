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

// Live mode: speed can change while running (UI slider). Re-anchors so now() never jumps.
export type ClockAnchor = { simAnchor: number; realAnchor: number; speed: number };
export function createAdjustableClock(opts: { simStart: number; speed: number }): Clock & { setSpeed(speed: number): void; anchor(): ClockAnchor; setAnchor(a: ClockAnchor): void } {
  let simAnchor = opts.simStart, realAnchor = Date.now(), speed = opts.speed;
  const now = () => simAnchor + (Date.now() - realAnchor) * speed;
  return {
    get speed() { return speed; },
    now,
    sleep: (simMs) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(simMs / speed, 1_000)))),   // wake at least every second: speed may change
    setSpeed(next) { simAnchor = now(); realAnchor = Date.now(); speed = next; },
    // Threads share one simulated time: copy the anchor (same wall clock, same formula, same answer).
    anchor: () => ({ simAnchor, realAnchor, speed }),
    setAnchor(x) { simAnchor = x.simAnchor; realAnchor = x.realAnchor; speed = x.speed; },
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
