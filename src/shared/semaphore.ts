export interface Semaphore { acquire(): Promise<void>; release(): void; inUse(): number; waiting(): number }

export function createSemaphore(n: number): Semaphore {
  let used = 0;
  const queue: (() => void)[] = [];
  return {
    acquire() { if (used < n) { used++; return Promise.resolve(); } return new Promise<void>((r) => queue.push(r)); },
    release() { const next = queue.shift(); if (next) next(); else used--; },
    inUse: () => used,
    waiting: () => queue.length,
  };
}
