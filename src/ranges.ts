/**
 * RangeSpec — the contract between a *deriver* and the *selector*.
 *
 * A deriver (the code heuristic in `none`, or a model in `local`/`remote`) turns
 * the heuristics (mood + period tone) into a RANGE for every color assignment.
 * This module does the other half: given the ranges, `selectPalette` picks the
 * EXACT shade inside each range at random. Ranges are bounded; the pick is free.
 *
 * All ranges are in OKLCH so "a range of shades" is perceptually meaningful.
 */

import { type Oklch, oklchToHex, wrapHue } from './color.js';
import type { Rng } from './rng.js';
import type { RawPalette, Scheme } from './types.js';

export interface Range {
  min: number;
  max: number;
}

/**
 * A hue range in degrees. If `min <= max` it is the arc [min, max]; if
 * `min > max` it wraps through 360 (e.g. {min:350, max:20} = 350°..360°..20°).
 */
export type HueRange = Range;

export interface SlotRange {
  L: Range;
  C: Range;
  h: HueRange;
}

export interface SchemeRanges {
  foreground: SlotRange;
  background: SlotRange;
  cursor: SlotRange;
  /** ANSI 0..15 */
  colors: SlotRange[];
}

export interface RangeSpec {
  light: SchemeRanges;
  dark: SchemeRanges;
}

function pick(r: Range, rng: Rng): number {
  if (r.max <= r.min) return r.min;
  return rng.range(r.min, r.max);
}

function pickHue(r: HueRange, rng: Rng): number {
  if (r.min <= r.max) return wrapHue(rng.range(r.min, r.max));
  // wrapping range: length is (360 - min) + max
  const span = 360 - r.min + r.max;
  return wrapHue(r.min + rng.next() * span);
}

export function selectShade(sr: SlotRange, rng: Rng): Oklch {
  return { L: pick(sr.L, rng), C: pick(sr.C, rng), h: pickHue(sr.h, rng) };
}

function selectScheme(s: SchemeRanges, rng: Rng): Scheme {
  return {
    foreground: oklchToHex(selectShade(s.foreground, rng)),
    background: oklchToHex(selectShade(s.background, rng)),
    cursor: oklchToHex(selectShade(s.cursor, rng)),
    colors: s.colors.map((c) => oklchToHex(selectShade(c, rng))),
  };
}

/** Randomly realize a concrete palette from the ranges. Bounded, but free inside. */
export function selectPalette(spec: RangeSpec, rng: Rng): RawPalette {
  return {
    light: selectScheme(spec.light, rng),
    dark: selectScheme(spec.dark, rng),
  };
}

// --- small helpers for derivers -------------------------------------------

/** A tight range centered on `c` with half-width `hw` (clamped to [lo,hi]). */
export function band(c: number, hw: number, lo = 0, hi = 1): Range {
  return { min: Math.max(lo, c - hw), max: Math.min(hi, c + hw) };
}

/** A hue range centered on `c` degrees with half-width `hw` degrees. */
export function hueBand(c: number, hw: number): HueRange {
  return { min: wrapHue(c - hw), max: wrapHue(c + hw) };
}
