/**
 * Tiny seeded PRNG (mulberry32). Deterministic: same seed -> same sequence, so
 * a palette is fully reproducible from (MoodInput, seed). No Math.random().
 */
export interface Rng {
  /** next float in [0, 1) */
  next(): number;
  /** float in [min, max) */
  range(min: number, max: number): number;
  /** pick one element */
  pick<T>(items: readonly T[]): T;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

/** Derive a stable numeric seed from an arbitrary string (FNV-1a). */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
