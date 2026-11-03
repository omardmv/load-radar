import { extractRules } from './extract.ts';
import { normalizeFields } from './normalize.ts';
import type { PlaceIndex } from './places.ts';
import type { CallContext, Extractor, ModelCall, ParseResult, RawFields } from './types.ts';

export type ParseMode = 'rules' | 'model' | 'hybrid';

// rules: regex only. model: the model's spans only. hybrid: rules first; the model fills gaps when rules
// miss the equipment or the origin (the two fields a search can't do without).
export async function parseSearch(text: string, opts: { places: PlaceIndex; mode: ParseMode; extractor?: Extractor; onModelCall?: (c: ModelCall) => void; context?: CallContext }): Promise<ParseResult> {
  const from: Partial<Record<keyof RawFields, 'rules' | 'model'>> = {};
  const fields: RawFields = {};
  if (opts.mode !== 'model') {
    Object.assign(fields, extractRules(text));
    for (const k of Object.keys(fields) as (keyof RawFields)[]) from[k] = 'rules';
  }
  const needModel = opts.mode === 'model' || (opts.mode === 'hybrid' && (!fields.equipment || !fields.originText));
  if (needModel) {
    if (!opts.extractor) throw new Error(`mode "${opts.mode}" needs an extractor`);
    const { fields: m, call } = await opts.extractor(text, opts.context);
    opts.onModelCall?.(call);
    for (const k of Object.keys(m) as (keyof RawFields)[]) {
      if (fields[k] !== undefined || m[k] === undefined) continue;
      Object.assign(fields, { [k]: m[k] });
      from[k] = 'model';
    }
  }
  return normalizeFields(fields, opts.places, from);
}
