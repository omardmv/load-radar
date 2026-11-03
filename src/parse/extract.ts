// Rules extractor: finds the structured tokens dispatchers write ("DH 150", "RPM 3.1", "$3.40/mi", "-> TX/OK").
// Returns raw spans only; normalize.ts interprets them.
import type { Equip } from '../shared/types.ts';
import { ANYWHERE_PHRASES, REGIONS } from './regions.ts';
import type { RawFields } from './types.ts';

export const EQUIP_PATTERNS: [RegExp, Equip][] = [
  [/\b(?:reefer|refrigerated)\b/i, 'reefer'],
  [/\b(?:flat ?bed|step ?deck|conestoga)\b/i, 'flatbed'],
  [/\b(?:dry ?van|van)\b/i, 'van'],
];
export const RATE_PATTERNS: RegExp[] = [
  /\brpm\s*\$?(\d+(?:\.\d+)?)/i,
  /\$?(\d+(?:\.\d+)?)\s*(?:\/\s*mi(?:le)?\b|a mile|per mile)/i,
  /(?:\bmin(?:imum)?|\bat least|\bover|\babove|\bpaying|\bpay)\s*\$?(\d+(?:\.\d+)?)/i,
  /\$?(\d+\.\d{1,2})\s*\+/,
  /\$(\d+\.\d{1,2})\b/,
  /\b(\d+\.\d{1,2})\s*min(?:imum)?\b/i,
  /\b(?:nothing|not|no(?:thing)? less than|never)\s*(?:under|below|less than)?\s*\$?(\d+(?:\.\d+)?)/i,   // "nothing under 2.80"
  /(?<![\d.])(\d\.\d{2})(?![\d.])/,              // last resort: a bare price like 2.80 in a search is a per-mile rate
];
export const DH_PATTERNS: RegExp[] = [
  /\bdh\s*(\d{1,3})\b/i,
  /\b(\d{1,3})\s*(?:mi|miles?)?\s*(?:dh|deadhead)\b/i,
  /\b(\d{1,3})\s*(?:mi|mile|miles)\s*radius\b/i,
  /\bradius\s*(?:of\s*)?(\d{1,3})\b/i,
  /\bdeadhead\s*(?:of|under|max|up to)?\s*(\d{1,3})\b/i,
];
const DEST_SEP = /(?:\s*(?:->|→)\s*|\b(?:heading|headed|going)(?:\s+to)?\s+|\bto\s+)/i;
const DEST_STOP = /\s*(?:\(|,(?!\s*[A-Za-z]{2}\b)|\s(?:van|reefer|flatbed|dry|paying|pay|min|minimum|under|over|dh|rpm|want|need|only|nothing|not|no|never|at least)\b|\s?\$|\s\d)/i;
const ORIGIN_PREP = /\b(?:out of|outta|from|empty in|in|near)\s+([a-z][a-z .'-]*?(?:,?\s+[a-z]{2})?)(?=\s*(?:,|$|-|\b(?:going|to|headed|heading|tmrw|tomorrow|today|tonight|want|need|paying|pay|dh|rpm|any|anywhere|van|reefer|flatbed|min|minimum|at least|nothing|not|no|never|over|above)\b|\d|\$))/i;
const NOISE = /\b(?:need|needs|looking|for|loads?|got|have|a|an|the|empty|only|truck|available|anything|any direction|anywhere)\b|\d+\s*ft\b|[,–-]/gi;

const firstMatch = (patterns: RegExp[], s: string) => { for (const re of patterns) { const m = re.exec(s); if (m) return m; } return null; };

export function extractRules(text: string): RawFields {
  const out: RawFields = {};
  for (const [re, e] of EQUIP_PATTERNS) if (re.test(text)) { out.equipment = e; break; }
  const rate = firstMatch(RATE_PATTERNS, text);
  if (rate && +rate[1] >= 0.5 && +rate[1] <= 15) out.rateText = rate[1];
  const dh = firstMatch(DH_PATTERNS, text);
  if (dh) out.deadheadText = dh[1];
  const radius = /\(within\s+(\d{1,3})\s*mi/i.exec(text);
  if (radius) out.destRadiusMi = Number(radius[1]);

  const sep = DEST_SEP.exec(text);
  const before = sep ? text.slice(0, sep.index) : text;
  if (sep) {
    const rest = text.slice(sep.index + sep[0].length);
    const stop = DEST_STOP.exec(rest);
    const d = (stop ? rest.slice(0, stop.index) : rest).trim().replace(/[,.;]+$/, '');
    if (d) out.destText = d;
  }
  if (out.destText === undefined) {                       // no "to"/"->": look for "anywhere" or a region word
    const lower = text.toLowerCase();
    if (ANYWHERE_PHRASES.some((w) => new RegExp(`\\b${w}\\b`).test(lower))) out.destText = 'anywhere';
    else {
      const region = Object.keys(REGIONS).find((r) => new RegExp(`\\b${r.toLowerCase()}\\b`).test(lower));
      if (region) out.destText = region.toLowerCase();
    }
  }

  const prep = ORIGIN_PREP.exec(before);
  if (prep) out.originText = prep[1].trim();
  else {                                                  // "Phoenix, AZ to …", "VAN DALLAS TX -> …": the place is what's left
    let p = before;
    for (const re of [...RATE_PATTERNS, ...DH_PATTERNS]) p = p.replace(re, ' ');
    for (const [re] of EQUIP_PATTERNS) p = p.replace(new RegExp(re.source, 'gi'), ' ');
    p = p.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (p) out.originText = p;
  }
  return out;
}
