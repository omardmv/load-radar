// Builds labeled same-load pairs: every new posting vs the earlier postings dedup would compare it with.
// Label 1 = both postings carry the same load_id in the generator's answer key (truth.ndjson).
//   node ml/dedup/export_pairs.ts --data ml/dedup/data/gen --out ml/dedup/data/pairs.csv
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGazetteer } from '../../src/normalize/gazetteer.ts';
import { createNormalizer } from '../../src/normalize/normalize.ts';
import { neighborCells } from '../../src/shared/geo.ts';
import { FEATURE_NAMES, pairFeatures, sideOf, type PairSide } from '../../src/dedup/features.ts';
import { sameLoadRule } from '../../src/dedup/dedup.ts';
import type { Board } from '../../src/shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());

export function exportPairs(dataDir: string): { header: string[]; rows: (number | string)[][]; positives: number } {
  const normalize = createNormalizer(loadGazetteer(join(here, '../../sim/data')));
  const truth = new Map<string, string>();
  for (const line of lines(join(dataDir, 'truth.ndjson'))) {
    const l = JSON.parse(line);
    for (const p of l.postings) truth.set(`${p.board}:${p.board_load_id}`, l.load_id);
  }
  const blocks = new Map<string, { side: PairSide; loadId: string }[]>();
  const seen = new Set<string>();
  const rows: (number | string)[][] = [];
  let positives = 0;
  for (const line of lines(join(dataDir, 'postings.ndjson'))) {
    const p = JSON.parse(line);
    const n = normalize({ board: p.board as Board, credentialId: null, userId: null, entryId: null, fetchedAt: 0, raw: p.raw });
    if (!n.ok || seen.has(n.load.key)) continue;          // refreshes of a known posting are stage 1's job
    seen.add(n.load.key);
    const l = n.load;
    const side = sideOf(l);
    const loadId = truth.get(l.key)!;
    for (const oc of neighborCells(l.origin.lat, l.origin.lon, 4)) {
      for (const c of blocks.get(`${l.pickupDate}|${oc}|${l.dest.cell4}|${l.equipment}`) ?? []) {
        if (Math.abs(c.side.postedAt - l.postedAt) > 6 * 3_600_000) continue;
        const label = c.loadId === loadId ? 1 : 0;
        positives += label;
        rows.push([...pairFeatures(c.side, side).map((x) => +x.toFixed(6)), sameLoadRule(c.side, side) ? 1 : 0, label, l.postedAt, c.loadId, loadId]);
      }
    }
    const k = `${l.pickupDate}|${l.origin.cell4}|${l.dest.cell4}|${l.equipment}`;
    const list = blocks.get(k);
    if (list) list.push({ side, loadId }); else blocks.set(k, [{ side, loadId }]);
  }
  return { header: [...FEATURE_NAMES, 'rule', 'label', 't', 'a_load', 'b_load'], rows, positives };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { data: { type: 'string' }, out: { type: 'string' } } });
  const r = exportPairs(a.data!);
  mkdirSync(dirname(a.out!), { recursive: true });
  writeFileSync(a.out!, [r.header.join(','), ...r.rows.map((x) => x.join(','))].join('\n') + '\n');
  console.log(JSON.stringify({ pairs: r.rows.length, positives: r.positives, out: a.out }));
}
