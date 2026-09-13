/**
 * Contrast harness — a deterministic constraint projection applied AFTER the
 * selector realizes a palette. The deriver/selector choose the mood's colors;
 * this pass guarantees the RESULT stays readable: each chromatic ANSI slot is
 * moved along its own lightness axis (hue and chroma preserved) until it clears a
 * contrast floor against its scheme's background.
 *
 * Why this exists: accents are chosen by hue identity but share one lightness,
 * and WCAG contrast tracks relative luminance — which varies by hue at equal
 * OKLCH L. "Bright" variants must move AWAY from the background in BOTH
 * polarities; on a light background that means darker, not the +L lift the range
 * builder implies.
 */

import { contrastHex, hexToOklch, oklchToHex } from './color.js';
import type { RawPalette, Scheme } from './types.js';

const NORMAL = [1, 2, 3, 4, 5, 6];
const BRIGHT = [9, 10, 11, 12, 13, 14];
const DIM = 8;

export const NORMAL_CONTRAST = 4.5; // WCAG AA body text
export const BRIGHT_CONTRAST = 6.0; // emphatic, and distinct from its normal twin
export const DIM_CONTRAST = 3.0; // bright-black: readable comments, still dim

/**
 * Return `hex` unchanged if it already meets `target` against `bgHex`; otherwise
 * move it along OKLCH L — preserving hue and chroma — by the smallest amount that
 * reaches the target. Contrast is monotonic in L, so we bisect.
 */
export function ensureContrast(hex: string, bgHex: string, target: number): string {
  if (contrastHex(hex, bgHex) >= target) return hex;

  // "away from the background": lighten on a dark bg, darken on a light one.
  const darkBg = contrastHex(bgHex, '#000000') < contrastHex(bgHex, '#ffffff');

  const { L, C, h } = hexToOklch(hex);
  let lo = darkBg ? L : 0;
  let hi = darkBg ? 1 : L;
  for (let k = 0; k < 32; k++) {
    const mid = (lo + hi) / 2;
    const meets = contrastHex(oklchToHex({ L: mid, C, h }), bgHex) >= target;
    if (darkBg ? meets : !meets) hi = mid;
    else lo = mid;
  }
  return oklchToHex({ L: darkBg ? hi : lo, C, h });
}

function project(scheme: Scheme): Scheme {
  const bg = scheme.background;
  const colors = [...scheme.colors];
  for (const i of NORMAL) colors[i] = ensureContrast(colors[i]!, bg, NORMAL_CONTRAST);
  for (const i of BRIGHT) colors[i] = ensureContrast(colors[i]!, bg, BRIGHT_CONTRAST);
  colors[DIM] = ensureContrast(colors[DIM]!, bg, DIM_CONTRAST);
  return { ...scheme, colors };
}

/** Pure: returns a contrast-corrected copy of `palette`. */
export function enforceContrast(palette: RawPalette): RawPalette {
  return { dark: project(palette.dark), light: project(palette.light) };
}
