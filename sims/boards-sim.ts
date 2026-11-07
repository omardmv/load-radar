// Simulated load boards (LLD 5.2): replays sim/gen.ts postings on the simulated clock, enforces per-login budgets.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSimClock, type Clock } from '../src/shared/clock.ts';
import { createTokenBucket, type TokenBucket } from '../src/shared/bucket.ts';
import { coverCells, geohash, milesBetween } from '../src/shared/geo.ts';
import { rawId } from '../src/normalize/normalize.ts';
import type { Board } from '../src/shared/types.ts';
import { coverTime } from './cover.ts';

export type SimItem = { postedAt: number; coveredAt: number; lat: number; lon: number; equip: string; pickup: string; raw: unknown };
export type BoardData = Map<string, Map<string, SimItem[]>>;   // board -> level-3 cell -> items by postedAt

const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

export function loadBoardData(postingsFile: string, truthFile: string): BoardData {
  const info = new Map<string, Omit<SimItem, 'postedAt' | 'raw'>>();
  for (const line of lines(truthFile)) {
    const l = JSON.parse(line);
    const coveredAt = coverTime(l.load_id, Date.parse(l.first_posted_at));
    for (const p of l.postings) info.set(`${p.board}:${p.board_load_id}`, { coveredAt, lat: l.origin.lat, lon: l.origin.lon, equip: l.equipment, pickup: l.pickup_date });
  }
  const data: BoardData = new Map();
  for (const line of lines(postingsFile)) {
    const p = JSON.parse(line);
    const i = info.get(`${p.board}:${rawId(p.board as Board, p.raw)}`);
    if (!i) continue;
    const cell = geohash(i.lat, i.lon, 3);
    if (!data.has(p.board)) data.set(p.board, new Map());
    const byCell = data.get(p.board)!;
    if (!byCell.has(cell)) byCell.set(cell, []);
    byCell.get(cell)!.push({ ...i, postedAt: Date.parse(p.posted_at), raw: p.raw });
  }
  for (const byCell of data.values()) for (const list of byCell.values()) list.sort((a, b) => a.postedAt - b.postedAt);
  return data;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const firstAfter = (list: SimItem[], since: number) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].postedAt <= since) lo = m + 1; else hi = m; } return lo; };

export function createBoardsHandler(data: BoardData, opts: { clock: Clock; budgetPerMin: number; banAfterRejects: number; banWindowMs: number }) {
  const creds = new Map<string, { bucket: TokenBucket; rejects: number[]; banned: boolean }>();
  const stats = { ok: 0, rejected: 0, bannedRequests: 0, bannedLogins: 0 };
  // Every login asks the same question again and again: remember which map cells a query covers (bounded cache).
  const cellsCache = new Map<string, string[]>();
  const cellsFor = (lat: number, lon: number, radius: number) => {
    const k = `${lat}|${lon}|${radius}`;
    let c = cellsCache.get(k);
    if (!c) { if (cellsCache.size > 100_000) cellsCache.clear(); c = coverCells(lat, lon, radius, 3); cellsCache.set(k, c); }
    return c;
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    // Parse "/<board>/loads?a=1&b=2" by hand: new URL() per request was a large share of the CPU.
    const raw = req.url ?? '/';
    const qi = raw.indexOf('?');
    const pathname = qi < 0 ? raw : raw.slice(0, qi);
    if (pathname === '/stats') { json(res, 200, stats); return; }
    const m = /^\/(dat|truckstop|portal_a|portal_b)\/loads$/.exec(pathname);
    if (!m) { json(res, 404, { error: 'not_found' }); return; }
    const now = opts.clock.now();
    const credId = String(req.headers['x-credential'] ?? '');
    let c = creds.get(credId);
    if (!c) { c = { bucket: createTokenBucket(opts.budgetPerMin, Math.max(1, opts.budgetPerMin / 6), opts.clock), rejects: [], banned: false }; creds.set(credId, c); }
    if (c.banned) { stats.bannedRequests++; json(res, 403, { error: 'account_suspended' }); return; }
    if (!c.bucket.take()) {
      c.rejects = c.rejects.filter((t) => now - t < opts.banWindowMs);
      c.rejects.push(now);
      stats.rejected++;
      if (c.rejects.length > opts.banAfterRejects) { c.banned = true; stats.bannedLogins++; json(res, 403, { error: 'account_suspended' }); return; }
      json(res, 429, { error: 'rate_limited' }, { 'retry-after': String(Math.max(1, Math.ceil((c.bucket.nextTokenAt() - now) / 1000))) });
      return;
    }
    const p: Record<string, string> = {};
    if (qi >= 0) for (const kv of raw.slice(qi + 1).split('&')) { const e = kv.indexOf('='); if (e > 0) p[kv.slice(0, e)] = decodeURIComponent(kv.slice(e + 1)); }
    const lat = Number(p.lat), lon = Number(p.lon), radius = Number(p.radius), since = Number(p.since ?? 0);
    const equip = (p.equipment ?? '').split(',');
    const from = p.pickup_from ?? '0000-00-00', to = p.pickup_to ?? '9999-99-99';
    const items: unknown[] = [];
    const byCell = data.get(m[1]);
    for (const cell of byCell ? cellsFor(lat, lon, radius) : []) {
      const list = byCell!.get(cell);
      if (!list) continue;
      for (let i = firstAfter(list, since); i < list.length && list[i].postedAt <= now && items.length < 500; i++) {
        const it = list[i];
        if (it.coveredAt <= now || !equip.includes(it.equip) || it.pickup < from || it.pickup > to) continue;
        if (milesBetween(lat, lon, it.lat, it.lon) > radius) continue;
        items.push(it.raw);
      }
    }
    stats.ok++;
    json(res, 200, { now, items });
  };
  return Object.assign(handler, { stats });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { data: { type: 'string', default: 'out' }, port: { type: 'string', default: '7001' }, 'sim-start': { type: 'string' }, 'real-start': { type: 'string' }, speed: { type: 'string', default: '1' }, budget: { type: 'string', default: '60' } } });
  const clock = createSimClock({ simStart: Date.parse(a['sim-start']!), realStart: Number(a['real-start']), speed: Number(a.speed) });
  const data = loadBoardData(join(a.data!, 'postings.ndjson'), join(a.data!, 'truth.ndjson'));
  const h = createBoardsHandler(data, { clock, budgetPerMin: Number(a.budget), banAfterRejects: 20, banWindowMs: 10 * 60_000 });
  createServer(h).listen(Number(a.port), '127.0.0.1', () => console.log(`boards-sim on :${a.port}`));
}
