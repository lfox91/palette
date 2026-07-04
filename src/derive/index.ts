/**
 * Deriver interface + selection. A deriver converts heuristics (mood + period
 * tone) into a RangeSpec of tight per-slot OKLCH bands; the SELECTOR (code)
 * then picks the exact shade within each band and validatePalette gates the
 * result. Generation is ALWAYS code — there is one deriver, the offline
 * heuristic. A model, if enabled, only *reviews* the finished palette
 * (src/review/) and can never originate a color or bypass validation.
 */

import type { RangeSpec } from '../ranges.js';
import type { Rng } from '../rng.js';
import type { MoodInput, ReviewMode, ToneWindow } from '../types.js';
import { deriveHeuristic } from './heuristic.js';

export interface Deriver {
  readonly mode: ReviewMode;
  derive(input: MoodInput, tone: ToneWindow, rng: Rng): RangeSpec | Promise<RangeSpec>;
}

export const heuristicDeriver: Deriver = {
  mode: 'none',
  derive: deriveHeuristic,
};

/**
 * Resolve the deriver. Generation is code-only, so there is a single deriver
 * regardless of review mode (review is a separate, post-generation step).
 * The parameter is kept for call-site symmetry.
 */
export function deriverFor(_mode: ReviewMode): Deriver {
  return heuristicDeriver;
}
