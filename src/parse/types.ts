import type { Dest, Equip } from '../shared/types.ts';
import type { KnownPlace } from './places.ts';

// What an extractor found: raw text spans, not yet interpreted.
export type RawFields = { equipment?: Equip | 'unspecified'; originText?: string; destText?: string; destRadiusMi?: number; rateText?: string; deadheadText?: string };
export type FieldName = 'equipment' | 'origin' | 'dest' | 'minRpm' | 'deadheadMi';
export type Source = 'rules' | 'model' | 'default';
export type ParsedDest = Dest & { label?: string };
export type ParseResult = {
  equipment: Equip | null; origin: KnownPlace | null; dest: ParsedDest | null; minRpm: number | null; deadheadMi: number;
  questions: string[]; sources: Partial<Record<FieldName, Source>>;
};
// traceId/observationId point at the call's GenAI span (Langfuse, Jaeger); null when tracing is off.
export type ModelCall = { model: string; latencyMs: number; promptTokens: number | null; outputTokens: number | null; output: unknown; traceId: string | null; observationId: string | null };
// Per-call context for observability: groups calls into a session and tags them.
export type CallContext = { sessionId?: string; metadata?: Record<string, string> };
export type Extractor = (text: string, ctx?: CallContext) => Promise<{ fields: RawFields; call: ModelCall }>;
