/**
 * Tone windows: how each period shifts the shade RANGES a deriver produces.
 * "up early" raises background lightness (whiter mornings); evening warms and
 * dims; owl darkens. These bias the ranges — the exact shade stays random.
 */

import type { ToneWindow } from './types.js';

const NEUTRAL: ToneWindow = { name: 'neutral', bgL: 0, accentL: 0, chroma: 1, warmth: 0 };

/** Tone windows for the 5 built-in periods. */
const BUILTIN_TONES: Record<string, ToneWindow> = {
  // up early: airier, backgrounds lift toward white, gentle warmth of dawn
  morning: { name: 'morning', bgL: 0.06, accentL: 0.02, chroma: 1.0, warmth: 5 },
  // midday: brightest, most saturated
  lunch: { name: 'lunch', bgL: 0.03, accentL: 0.03, chroma: 1.06, warmth: 0 },
  // steady, neutral reference tone
  afternoon: { name: 'afternoon', bgL: 0.0, accentL: 0.0, chroma: 1.0, warmth: 2 },
  // golden hour: warmer, a touch dimmer
  evening: { name: 'evening', bgL: -0.03, accentL: -0.02, chroma: 0.92, warmth: 14 },
  // deep night: darkest, dimmest, slight warmth to ease the eyes
  owl: { name: 'owl', bgL: -0.06, accentL: -0.04, chroma: 0.84, warmth: 7 },
};

/** Resolve a period name to its tone window; unknown/custom periods are neutral. */
export function toneFor(periodName: string): ToneWindow {
  return BUILTIN_TONES[periodName] ?? { ...NEUTRAL, name: periodName };
}

export { NEUTRAL as NEUTRAL_TONE };
