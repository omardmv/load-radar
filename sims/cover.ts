// When a load gets taken ("covered"): deterministic per load id, lognormal around `medianMin` minutes.
export function coverTime(loadId: string, firstPostedAt: number, medianMin = 20): number {
  let h = 2166136261;
  for (let i = 0; i < loadId.length; i++) { h ^= loadId.charCodeAt(i); h = Math.imul(h, 16777619); }
  const u1 = (((h >>> 0) % 1_000_000) + 0.5) / 1_000_000;
  h = Math.imul(h ^ (h >>> 13), 16777619);
  const u2 = (((h >>> 0) % 1_000_000) + 0.5) / 1_000_000;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return firstPostedAt + medianMin * 60_000 * Math.exp(0.6 * z);
}
