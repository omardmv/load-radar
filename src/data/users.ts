import { readFileSync } from 'node:fs';
import type { Board, Dest, Equip, User } from '../shared/types.ts';

// Reads sim/gen.ts searches.ndjson. (Production keeps users in a database on the cold path.)
export function loadUsers(searchesFile: string): User[] {
  return readFileSync(searchesFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => toUser(JSON.parse(l)));
}

// One generator user record (sim/world.ts makeUser) -> engine User.
export function toUser(u: any): User {
  return {
    userId: u.user_id,
    credentials: u.credentials.map((c: { board: Board; credential_id: string }) => ({ credentialId: c.credential_id, userId: u.user_id, board: c.board })),
    searches: u.searches.map((s: any) => {
      const dest: Dest = s.dest.kind === 'market' ? { kind: 'point', lat: s.dest.lat, lon: s.dest.lon, radiusMi: s.dest.radius_mi }
        : s.dest.kind === 'states' ? { kind: 'states', states: s.dest.states } : { kind: 'anywhere' };
      return { searchId: s.search_id, userId: u.user_id, lat: s.origin.lat, lon: s.origin.lon, deadheadMi: s.deadhead_mi, dest,
        equipment: s.equipment as Equip, minRpm: s.min_rpm, includeNoRate: true, pickupWithinDays: s.pickup_within_days };
    }),
  };
}
