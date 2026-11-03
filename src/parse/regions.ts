export const STATES: Record<string, string> = {
  AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS', CA: 'CALIFORNIA', CO: 'COLORADO', CT: 'CONNECTICUT', DE: 'DELAWARE',
  DC: 'DISTRICT OF COLUMBIA', FL: 'FLORIDA', GA: 'GEORGIA', HI: 'HAWAII', ID: 'IDAHO', IL: 'ILLINOIS', IN: 'INDIANA', IA: 'IOWA',
  KS: 'KANSAS', KY: 'KENTUCKY', LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND', MA: 'MASSACHUSETTS', MI: 'MICHIGAN', MN: 'MINNESOTA',
  MS: 'MISSISSIPPI', MO: 'MISSOURI', MT: 'MONTANA', NE: 'NEBRASKA', NV: 'NEVADA', NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY', NM: 'NEW MEXICO',
  NY: 'NEW YORK', NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO', OK: 'OKLAHOMA', OR: 'OREGON', PA: 'PENNSYLVANIA', RI: 'RHODE ISLAND',
  SC: 'SOUTH CAROLINA', SD: 'SOUTH DAKOTA', TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH', VT: 'VERMONT', VA: 'VIRGINIA', WA: 'WASHINGTON',
  WV: 'WEST VIRGINIA', WI: 'WISCONSIN', WY: 'WYOMING',
};

// Multi-word regions first, so "west coast" is found before anything shorter.
export const REGIONS: Record<string, string[]> = {
  'WEST COAST': ['CA', 'OR', 'WA'],
  'EAST COAST': ['CT', 'DE', 'FL', 'GA', 'MA', 'MD', 'ME', 'NC', 'NH', 'NJ', 'NY', 'RI', 'SC', 'VA'],
  SOUTHEAST: ['AL', 'FL', 'GA', 'MS', 'NC', 'SC', 'TN'],
  NORTHEAST: ['CT', 'MA', 'ME', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT'],
  MIDWEST: ['IA', 'IL', 'IN', 'MI', 'MN', 'MO', 'OH', 'WI'],
  SOUTHWEST: ['AZ', 'NM', 'OK', 'TX'],
  NORTHWEST: ['ID', 'OR', 'WA'],
};

export const DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'northbound', 'southbound', 'eastbound', 'westbound']);
export const ANYWHERE = new Set(['anywhere', 'any', 'any direction', 'wherever', 'everywhere']);
export const ANYWHERE_PHRASES = ['anywhere', 'any direction', 'wherever', 'everywhere'];   // safe to search for inside a sentence

export function stateCode(token: string): string | null {
  const u = token.trim().toUpperCase();
  if (STATES[u]) return u;
  for (const [code, name] of Object.entries(STATES)) if (name === u) return code;
  return null;
}
