import type { Clock } from '../shared/clock.ts';
import type { Equip } from '../shared/types.ts';

// New postings per simulated minute per (level-3 cell, equipment), as an EWMA (LLD 6.2).
export function createHeat(clock: Clock, alpha = 0.1, prior = 0.05) {
  const m = new Map<string, { ewma: number; minute: number; count: number }>();
  const roll = (s: { ewma: number; minute: number; count: number }, minute: number) => {
    const gap = minute - s.minute;
    if (gap <= 0) return;
    const first = alpha * s.count + (1 - alpha) * s.ewma;
    s.ewma = first * (1 - alpha) ** (gap - 1);
    s.count = 0;
    s.minute = minute;
  };
  return {
    record(cell3: string, equip: Equip) {
      const k = `${cell3}|${equip}`;
      const minute = Math.floor(clock.now() / 60_000);
      let s = m.get(k);
      if (!s) { s = { ewma: prior, minute, count: 0 }; m.set(k, s); }
      roll(s, minute);
      s.count++;
    },
    get(cell3: string, equip: Equip): number {
      const s = m.get(`${cell3}|${equip}`);
      if (!s) return prior;
      roll(s, Math.floor(clock.now() / 60_000));
      return s.ewma;
    },
  };
}
