import type { Equip } from '../../src/shared/types.ts';
import type { ParseResult, ParsedDest } from '../../src/parse/types.ts';

export type EvalExample = { text: string; kind: 'template' | 'messy'; equipment: Equip | null; origin: string | null; dest: string; minRpm: number | null; deadheadMi: number; ask: boolean };
export const FIELDS = ['equipment', 'origin', 'dest', 'minRpm', 'deadheadMi', 'ask'] as const;

const name = (s: string) => s.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

export function destKey(d: ParsedDest | null): string {
  if (!d) return '?';
  if (d.kind === 'anywhere') return 'anywhere';
  if (d.kind === 'states') return `states:${[...d.states].sort().join(',')}`;
  return `point:${name(d.label ?? '')}`;
}

export function scoreExample(e: EvalExample, r: ParseResult): Record<(typeof FIELDS)[number] | 'all', boolean> {
  const want = e.dest.startsWith('point:') ? `point:${name(e.dest.slice(6))}` : e.dest;
  const s = {
    equipment: r.equipment === e.equipment,
    origin: (r.origin ? name(`${r.origin.city}, ${r.origin.state}`) : null) === (e.origin ? name(e.origin) : null),
    dest: destKey(r.dest) === want,
    minRpm: e.minRpm === null ? r.minRpm === null : r.minRpm !== null && Math.abs(r.minRpm - e.minRpm) < 0.005,
    deadheadMi: r.deadheadMi === e.deadheadMi,
    ask: (r.questions.length > 0) === e.ask,
  };
  return { ...s, all: Object.values(s).every(Boolean) };
}
