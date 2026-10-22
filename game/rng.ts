// Seeded PRNG (mulberry32). State is a single uint32 kept in plain data, so a world stays
// serialisable and the same seed always replays the same round.

/** Returns [value in [0, 1), next state]. */
export function nextRandom(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0
  let t = s
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s]
}

/** Normalise any number into a valid non-zero uint32 seed. */
export function seedState(seed: number): number {
  const s = Math.floor(Math.abs(seed)) >>> 0
  return s === 0 ? 0x9e3779b9 : s
}

/** Convenience for objects that carry an rngState field: draws one value and advances it. */
export function rand(holder: { rngState: number }): number {
  const [v, s] = nextRandom(holder.rngState)
  holder.rngState = s
  return v
}

/** Uniform in [min, max). */
export function randRange(holder: { rngState: number }, min: number, max: number): number {
  return min + rand(holder) * (max - min)
}
