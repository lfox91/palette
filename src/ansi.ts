/**
 * The ANSI-16 semantic contract.
 *
 * Every consumer of a terminal palette — Ptyxis, tmux, nvim, LS_COLORS, git
 * diff, language syntax themes, and agent/TUI harnesses — reads the SAME 16
 * slots and, despite their different mappings, expects the SAME roles:
 *
 *   0  black         background / "hi black" (tmux, nvim chrome)
 *   1  red           error, deletion (git), broken symlink (LS_COLORS)
 *   2  green         success, addition (git), executable (LS_COLORS), string
 *   3  yellow        warning, modified (git), type/class
 *   4  blue          directory (LS_COLORS), function, info
 *   5  magenta       media/archive (LS_COLORS), keyword
 *   6  cyan          symlink (LS_COLORS), constant, identifier
 *   7  white         default text on a dark background
 *   8  bright black  comments / dim text, subtle chrome
 *   9–14             bright variants of 1–6 (same role, more emphatic)
 *   15 bright white  emphasis text
 *
 * Because the roles are shared, the HUES are not free per mood. A mood may move
 * chroma, lightness, and cast-adjacent accents — but red must stay red and
 * magenta must stay magenta, or red↔magenta collide and the role stops
 * signalling. `ANSI_HUE` is that anchor; `validate.ts` reports drift from it.
 */

export interface AnsiRole {
  slot: number;
  name: string;
  /** where this role is consumed, in practice */
  consumers: string;
}

export const ANSI_ROLES: readonly AnsiRole[] = [
  { slot: 0, name: 'black', consumers: 'terminal / tmux / nvim background' },
  { slot: 1, name: 'red', consumers: 'errors, git deletions, broken symlinks' },
  { slot: 2, name: 'green', consumers: 'success, additions, executables, strings' },
  { slot: 3, name: 'yellow', consumers: 'warnings, modifications, types' },
  { slot: 4, name: 'blue', consumers: 'directories, functions, info' },
  { slot: 5, name: 'magenta', consumers: 'media/archives, keywords' },
  { slot: 6, name: 'cyan', consumers: 'symlinks, constants, identifiers' },
  { slot: 7, name: 'white', consumers: 'default text on dark' },
  { slot: 8, name: 'bright black', consumers: 'comments, dim chrome' },
  { slot: 9, name: 'bright red', consumers: 'as red, more emphatic' },
  { slot: 10, name: 'bright green', consumers: 'as green, more emphatic' },
  { slot: 11, name: 'bright yellow', consumers: 'as yellow, more emphatic' },
  { slot: 12, name: 'bright blue', consumers: 'as blue, more emphatic' },
  { slot: 13, name: 'bright magenta', consumers: 'as magenta, more emphatic' },
  { slot: 14, name: 'bright cyan', consumers: 'as cyan, more emphatic' },
  { slot: 15, name: 'bright white', consumers: 'emphasis text' },
];

/** Canonical hue for each chromatic slot — the role's identity, in OKLCH degrees. */
export const ANSI_HUE: Record<number, number> = { 1: 29, 2: 142, 3: 100, 4: 264, 5: 328, 6: 195 };

/** How far (degrees) a chromatic slot may stray from its role before it conflicts. */
export const ANSI_HUE_MAX_DEVIATION = 18;

/** Human name for a slot, e.g. 5 -> "magenta", 13 -> "bright magenta". */
export function chromaName(slot: number): string {
  return ANSI_ROLES[slot]?.name ?? `color${slot}`;
}
