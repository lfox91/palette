/**
 * validatePalette — the single gate every palette flows through, whether it
 * came from the code generator or an AI reviewer's tweak. Two concerns, one
 * pass:
 *   SAFETY   — valid hex, structural completeness, WCAG fg/bg contrast.
 *   AESTHETIC — perceptual spacing between ANSI slots + hue coherence, so the
 *               set is distinct AND reads as one intentional palette.
 * Nothing muddy or unreadable is ever written or applied.
 */

import { ANSI_HUE, ANSI_HUE_MAX_DEVIATION, chromaName } from './ansi.js';
import { contrastHex, deltaEOk, hexToOklch, hueDistance, isValidHex } from './color.js';
import type { RawPalette, Scheme } from './types.js';

export interface ValidationIssue {
  scheme: 'light' | 'dark';
  kind: 'structure' | 'hex' | 'contrast' | 'spacing' | 'coherence';
  slot?: string;
  message: string;
  /** true if this alone makes the palette unusable (vs. an aesthetic warning) */
  fatal: boolean;
}

export interface ValidationResult {
  ok: boolean; // no fatal issues
  clean: boolean; // no issues at all (fatal or aesthetic)
  issues: ValidationIssue[];
}

// Tunable thresholds. WCAG AA body text is 4.5:1. Perceptual thresholds are in
// OKLab distance units (roughly: 0.02 is a just-noticeable difference).
export const MIN_FG_BG_CONTRAST = 4.5;
export const MIN_HUE_SEPARATION_DELTAE = 0.06; // between the 6 chromatic hues
export const MIN_BRIGHT_OFFSET_DELTAE = 0.02; // between a normal slot and its bright twin
export const MIN_BLACK_WHITE_LIGHTNESS = 0.5; // L difference between color0 and color15

/** Chromatic ANSI slots (red, green, yellow, blue, magenta, cyan). */
const CHROMATIC = [1, 2, 3, 4, 5, 6];

export function validatePalette(palette: RawPalette): ValidationResult {
  const issues: ValidationIssue[] = [];
  validateScheme(palette.light, 'light', issues);
  validateScheme(palette.dark, 'dark', issues);
  const fatal = issues.some((i) => i.fatal);
  return { ok: !fatal, clean: issues.length === 0, issues };
}

function validateScheme(scheme: Scheme, which: 'light' | 'dark', issues: ValidationIssue[]): void {
  const add = (
    kind: ValidationIssue['kind'],
    message: string,
    fatal: boolean,
    slot?: string
  ): void => {
    issues.push({ scheme: which, kind, message, fatal, slot });
  };

  // --- structure ---
  if (scheme.colors?.length !== 16) {
    add('structure', `expected 16 ANSI colors, got ${scheme.colors?.length ?? 0}`, true);
    return; // can't check the rest meaningfully
  }
  for (const [label, hex] of [
    ['foreground', scheme.foreground],
    ['background', scheme.background],
    ['cursor', scheme.cursor],
  ] as const) {
    if (!hex || !isValidHex(hex))
      add('hex', `${label} is not a valid hex color: ${hex}`, true, label);
  }
  scheme.colors.forEach((hex, i) => {
    if (!hex || !isValidHex(hex))
      add('hex', `color${i} is not a valid hex color: ${hex}`, true, `color${i}`);
  });
  if (issues.some((i) => i.scheme === which && i.fatal)) return;

  // --- safety: contrast ---
  const fgbg = contrastHex(scheme.foreground, scheme.background);
  if (fgbg < MIN_FG_BG_CONTRAST) {
    add(
      'contrast',
      `foreground/background contrast ${fgbg.toFixed(2)}:1 < ${MIN_FG_BG_CONTRAST}:1`,
      true
    );
  }
  // Each chromatic color should be legible on the background (AA-ish, 3:1 for
  // large glyphs — terminal text is small so we aim higher but don't hard-fail
  // below 4.5, only warn, since some accent slots read fine as syntax accents).
  for (const i of CHROMATIC) {
    const c = contrastHex(scheme.colors[i]!, scheme.background);
    if (c < 3)
      add(
        'contrast',
        `color${i} contrast on background ${c.toFixed(2)}:1 < 3:1`,
        false,
        `color${i}`
      );
  }

  // --- aesthetic: perceptual spacing between the 6 chromatic hues ---
  const lch = scheme.colors.map((h) => hexToOklch(h));
  for (let a = 0; a < CHROMATIC.length; a++) {
    for (let b = a + 1; b < CHROMATIC.length; b++) {
      const ia = CHROMATIC[a]!;
      const ib = CHROMATIC[b]!;
      const d = deltaEOk(lch[ia]!, lch[ib]!);
      if (d < MIN_HUE_SEPARATION_DELTAE) {
        add(
          'spacing',
          `color${ia} and color${ib} are perceptually too close (ΔE ${d.toFixed(3)} < ${MIN_HUE_SEPARATION_DELTAE})`,
          false,
          `color${ia}`
        );
      }
    }
  }

  // --- aesthetic: normal vs bright variant should differ but not diverge ---
  for (let i = 0; i < 8; i++) {
    const d = deltaEOk(lch[i]!, lch[i + 8]!);
    if (d < MIN_BRIGHT_OFFSET_DELTAE) {
      add(
        'spacing',
        `color${i} and its bright variant color${i + 8} are nearly identical (ΔE ${d.toFixed(3)})`,
        false,
        `color${i + 8}`
      );
    }
  }

  // --- aesthetic: black (0) and white (15) must span the lightness range ---
  const lightnessSpan = Math.abs(lch[15]!.L - lch[0]!.L);
  if (lightnessSpan < MIN_BLACK_WHITE_LIGHTNESS) {
    add(
      'coherence',
      `color0/color15 lightness span ${lightnessSpan.toFixed(2)} < ${MIN_BLACK_WHITE_LIGHTNESS} (grays look flat)`,
      false,
      'color15'
    );
  }

  // --- semantic: a chromatic slot must stay near its terminal role's hue, or
  // roles collide (e.g. red vs magenta, green vs yellow) across tmux/nvim/
  // LS_COLORS/syntax themes. Reported, never hidden. ---
  for (const [slot, canonical] of Object.entries(ANSI_HUE)) {
    const i = Number(slot);
    const dev = hueDistance(lch[i]!.h, canonical);
    if (dev > ANSI_HUE_MAX_DEVIATION) {
      add(
        'coherence',
        `color${i} (${chromaName(i)}) is ${dev.toFixed(0)}° off its terminal role (${canonical}°); hues may collide across tmux/nvim/LS_COLORS`,
        false,
        `color${i}`
      );
    }
  }
}

/**
 * Format a validation result for CLI display. Returns null if clean.
 */
export function formatIssues(result: ValidationResult): string | null {
  if (result.clean) return null;
  const lines = result.issues.map((i) => {
    const tag = i.fatal ? 'FATAL' : 'warn';
    const slot = i.slot ? ` [${i.slot}]` : '';
    return `  ${tag} (${i.scheme}/${i.kind})${slot}: ${i.message}`;
  });
  return lines.join('\n');
}
