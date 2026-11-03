const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const R = Math.PI / 180;

export function geohash(lat: number, lon: number, precision: number): string {
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180, out = '', bit = 0, ch = 0, even = true;
  while (out.length < precision) {
    if (even) { const m = (lonLo + lonHi) / 2; if (lon >= m) { ch = ch * 2 + 1; lonLo = m; } else { ch *= 2; lonHi = m; } }
    else { const m = (latLo + latHi) / 2; if (lat >= m) { ch = ch * 2 + 1; latLo = m; } else { ch *= 2; latHi = m; } }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

export function cellBounds(hash: string) {
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180, even = true;
  for (const c of hash) {
    const v = B32.indexOf(c);
    for (let b = 4; b >= 0; b--) {
      const bit = (v >> b) & 1;
      if (even) { const m = (lonLo + lonHi) / 2; if (bit) lonLo = m; else lonHi = m; }
      else { const m = (latLo + latHi) / 2; if (bit) latLo = m; else latHi = m; }
      even = !even;
    }
  }
  return { latLo, latHi, lonLo, lonHi };
}

export function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const h = Math.sin((bLat - aLat) * R / 2) ** 2 + Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin((bLon - aLon) * R / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

const cellSize = (precision: number) => {
  const bits = precision * 5;
  return { dlat: 180 / 2 ** Math.floor(bits / 2), dlon: 360 / 2 ** Math.ceil(bits / 2) };
};

// Every cell whose rectangle comes within radiusMi of the point (nearest point of the cell <= radius).
export function coverCells(lat: number, lon: number, radiusMi: number, precision: number): string[] {
  const { dlat, dlon } = cellSize(precision);
  const spanLat = radiusMi / 69 + dlat;
  const spanLon = radiusMi / (69 * Math.max(0.2, Math.cos(lat * R))) + dlon;
  const cells = new Set<string>();
  const out: string[] = [];
  for (let la = lat - spanLat; la <= lat + spanLat + dlat / 2; la += dlat / 2) {
    for (let lo = lon - spanLon; lo <= lon + spanLon + dlon / 2; lo += dlon / 2) {
      const h = geohash(Math.max(-90, Math.min(89.9999, la)), ((lo + 540) % 360) - 180, precision);
      if (cells.has(h)) continue;
      cells.add(h);
      const b = cellBounds(h);
      const nLat = Math.min(Math.max(lat, b.latLo), b.latHi), nLon = Math.min(Math.max(lon, b.lonLo), b.lonHi);
      if (milesBetween(lat, lon, nLat, nLon) <= radiusMi) out.push(h);
    }
  }
  return out;
}

export function neighborCells(lat: number, lon: number, precision: number): string[] {
  const { dlat, dlon } = cellSize(precision);
  const out = new Set<string>();
  for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) out.add(geohash(lat + a * dlat, lon + b * dlon, precision));
  return [...out];
}

export const centralDate = (ms: number): string => new Date(ms - 6 * 3_600_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
