export type Equip = 'van' | 'reefer' | 'flatbed';
export type Board = 'dat' | 'truckstop' | 'portal_a' | 'portal_b';
export const BOARDS: Board[] = ['dat', 'truckstop', 'portal_a', 'portal_b'];

export type Dest = { kind: 'anywhere' } | { kind: 'states'; states: string[] } | { kind: 'point'; lat: number; lon: number; radiusMi: number };

export interface SearchSpec {
  searchId: string; userId: string;
  lat: number; lon: number; deadheadMi: number;
  dest: Dest; equipment: Equip;
  minRpm: number | null; includeNoRate: boolean; pickupWithinDays: number;
}
export interface Credential { credentialId: string; userId: string; board: Board }
export interface User { userId: string; credentials: Credential[]; searches: SearchSpec[] }

export interface PlanQuery { lat: number; lon: number; radiusMi: number; equipment: Equip[] }
export interface PlanEntry {
  entryId: string; credentialId: string; userId: string; board: Board;
  query: PlanQuery; searchIds: string[];
  heat: number;        // expected new postings per simulated minute in the covered cells
  intervalMs: number;  // simulated ms between polls
  cursor: number;      // board time of the last successful poll (simulated ms)
}

export type Visibility = { kind: 'all' } | { kind: 'user'; userId: string };
export interface Place { city: string; state: string; lat: number; lon: number; cell4: string }
export interface Load {
  key: string; board: Board; boardLoadId: string; brokerMc: string;
  origin: Place; dest: Place; equipment: Equip; equipmentDetail: string;
  rate: number | null; miles: number; pickupDate: string;
  postedAt: number; contentHash: string; visibleTo: Visibility;
  canonicalId: string;   // '' until dedup assigns it
}
export interface RawPosting { board: Board; credentialId: string | null; userId: string | null; entryId: string | null; fetchedAt: number; raw: unknown }
export interface Alert { userId: string; canonicalId: string; loadKey: string; searchIds: string[]; summary: string; postedAt: number; enqueuedAt: number }
