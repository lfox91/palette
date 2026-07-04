/**
 * Generation orchestration: heuristics -> ranges (deriver) -> random shade
 * selection (code) -> validation. RANDOM AND BOUNDED: every call draws fresh
 * randomness, so the same mood yields a different — but always coherent and
 * legible — palette. The deriver sets the bounds; the selector picks inside them.
 *
 * There is no seed to replay. A saved version stores its resulting colors.
 */

import { type Deriver, heuristicDeriver } from './derive/index.js';
import { selectPalette } from './ranges.js';
import { makeRng } from './rng.js';
import { toneFor } from './tone.js';
import type { MoodInput, RawPalette } from './types.js';
import { type ValidationResult, validatePalette } from './validate.js';

/** Draw a fresh 32-bit random value from the platform CSPRNG. */
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

export interface GenerateOptions {
  /** which deriver to use; defaults to the offline heuristic (`none`) */
  deriver?: Deriver;
  /** period name whose tone window shapes the ranges; defaults to neutral */
  period?: string;
  /** how many random selections to try for a fatal-free palette */
  maxAttempts?: number;
}

export interface GenerateResult {
  palette: RawPalette;
  validation: ValidationResult;
}

/**
 * Generate a palette. Derives ranges once, then random-selects shades, re-rolling
 * until a fatal-free palette is found (ranges are constructed so this converges
 * quickly). Returns the best result with its validation report either way.
 */
export async function generatePalette(
  input: MoodInput,
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const deriver = opts.deriver ?? heuristicDeriver;
  const tone = toneFor(opts.period ?? 'afternoon');
  const maxAttempts = opts.maxAttempts ?? 48;

  const rng = makeRng(randomSeed());
  const spec = await deriver.derive(input, tone, rng);

  // Preference: clean (no issues) > ok (no fatal) > anything. Keep the best seen.
  let best: GenerateResult | null = null;
  const rank = (v: ValidationResult): number => (v.clean ? 2 : v.ok ? 1 : 0);
  for (let i = 0; i < maxAttempts; i++) {
    const palette = selectPalette(spec, rng);
    const validation = validatePalette(palette);
    if (validation.clean) return { palette, validation }; // best possible; stop early
    if (!best || rank(validation) > rank(best.validation)) best = { palette, validation };
  }
  return best!;
}
