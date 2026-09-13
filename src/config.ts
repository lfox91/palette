/**
 * Config store — the source of truth on disk, under ~/.config/palette/
 * (override with PALETTE_CONFIG_DIR, honors XDG_CONFIG_HOME):
 *
 *   config.json    — defaults, review mode, model path, remote provider
 *   schedule.json  — periods, period→version assignments, saved versions, override
 *   last_regen     — ISO date of the last timer regeneration (idempotency gate)
 *   models/        — pulled GGUFs for local review
 *
 * Ships two built-in versions, Day and Evening: a Solarized base16 core with the
 * green/cyan accents nudged toward GNOME Sweet's signature green. Evening is
 * derived from Day by a deterministic warm-and-dim transform in OKLCH.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ANSI_HUE } from './ansi.js';
import { hexToOklch, oklchToHex, pullHue } from './color.js';
import { enforceContrast } from './contrast.js';
import { defaultPeriods } from './periods.js';
import type { PaletteConfig, PaletteVersion, RawPalette, ScheduleConfig, Scheme } from './types.js';

// --- paths -----------------------------------------------------------------

export interface Paths {
  base: string;
  config: string;
  schedule: string;
  lastRegen: string;
  models: string;
}

export function paths(): Paths {
  const base =
    process.env.PALETTE_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'palette');
  return {
    base,
    config: join(base, 'config.json'),
    schedule: join(base, 'schedule.json'),
    lastRegen: join(base, 'last_regen'),
    models: join(base, 'models'),
  };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    // Never silently discard user state: move the unreadable file aside so it
    // can be recovered, instead of letting the next save overwrite it.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      renameSync(file, `${file}.corrupt-${stamp}`);
    } catch {
      /* best effort — fall back to defaults even if we cannot move it */
    }
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDir(paths().base);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * First name not already taken: `base`, else `base-2`, `base-3`, … Used so a
 * conflicting period/palette name triggers a RENAME rather than a silent
 * overwrite of the user's saved state.
 */
export function nextFreeName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// --- seed palettes: Solarized × GNOME Sweet --------------------------------

/**
 * The 16 ANSI slots, canonical Solarized mapping, with the green (2) and cyan
 * (6) accents nudged toward GNOME Sweet's more vivid green. Solarized shares one
 * 16-color set between light and dark; only fg/bg/cursor differ per scheme.
 * (Exact hues are a coherent starting point; fine-tune live in Ptyxis.)
 */
const SOLARIZED_ANSI: string[] = [
  '#073642', // 0  base02
  '#dc322f', // 1  red
  '#8bab00', // 2  green  (Solarized #859900 nudged brighter/greener — Sweet)
  '#b58900', // 3  yellow
  '#268bd2', // 4  blue
  '#d33682', // 5  magenta
  '#20b2a0', // 6  cyan   (Solarized #2aa198 nudged toward teal-green — Sweet)
  '#eee8d5', // 7  base2
  '#002b36', // 8  base03
  '#cb4b16', // 9  orange
  '#586e75', // 10 base01
  '#657b83', // 11 base00
  '#839496', // 12 base0
  '#6c71c4', // 13 violet
  '#93a1a1', // 14 base1
  '#fdf6e3', // 15 base3
];

/**
 * Canonical terminal-role hues (see src/ansi.ts). Slots 1–6 are the semantic
 * contract the validator enforces; 9 and 13 are the bright counterparts of red
 * and magenta, so they share those hues. The Solarized seed's faint drift off
 * these roles is exactly what made "media" read like "error" — snapped here.
 */
const CANON_HUE: Record<number, number> = {
  1: ANSI_HUE[1]!,
  2: ANSI_HUE[2]!,
  3: ANSI_HUE[3]!,
  4: ANSI_HUE[4]!,
  5: ANSI_HUE[5]!,
  6: ANSI_HUE[6]!,
  9: ANSI_HUE[1]!,
  13: ANSI_HUE[5]!,
};

/** Snap a scheme's chromatic slots to their canonical role hue, keeping L/C. */
function snapRoles(scheme: Scheme): Scheme {
  const colors = scheme.colors.map((hex, i) => {
    const h = CANON_HUE[i];
    if (h === undefined) return hex;
    const c = hexToOklch(hex);
    return oklchToHex({ L: c.L, C: c.C, h });
  });
  return { ...scheme, colors };
}

function dayLight(): Scheme {
  return {
    background: '#fdf6e3', // base3
    foreground: '#586e75', // base01 (Solarized's high-contrast text — clears WCAG 4.5:1)
    cursor: '#073642', // base02
    colors: [...SOLARIZED_ANSI],
  };
}

function dayDark(): Scheme {
  return {
    background: '#002b36', // base03
    foreground: '#839496', // base0
    cursor: '#93a1a1', // base1
    colors: [...SOLARIZED_ANSI],
  };
}

/** Chromatic slots that get warmed/dimmed for Evening (skip structural 0/7/8/15). */
const CHROMATIC_SLOTS = [1, 2, 3, 4, 5, 6, 9, 13];

/** Warm a hex toward the orange pole and reduce chroma; optional lightness delta. */
function warmDim(hex: string, huePull: number, chromaMul: number, lDelta = 0): string {
  const c = hexToOklch(hex);
  return oklchToHex({
    L: Math.max(0, Math.min(1, c.L + lDelta)),
    C: c.C * chromaMul,
    h: pullHue(c.h, 60, huePull), // 60° ≈ warm orange
  });
}

/** Derive Evening's scheme from Day's: warmer, dimmer — the end-of-day mood. */
function eveningScheme(day: Scheme, isDark: boolean): Scheme {
  const colors = day.colors.map((hex, i) =>
    CHROMATIC_SLOTS.includes(i) ? warmDim(hex, 6, 0.82) : hex
  );
  return {
    // warm the background a touch; dim slightly on dark, keep light legible
    background: warmDim(day.background, 10, 0.95, isDark ? -0.008 : -0.004),
    foreground: warmDim(day.foreground, 4, 0.95),
    cursor: warmDim(day.cursor, 8, 0.9),
    colors,
  };
}

export function dayPalette(): RawPalette {
  return enforceContrast({ light: snapRoles(dayLight()), dark: snapRoles(dayDark()) });
}

export function eveningPalette(): RawPalette {
  const day = dayPalette();
  return enforceContrast({
    light: snapRoles(eveningScheme(day.light, false)),
    dark: snapRoles(eveningScheme(day.dark, true)),
  });
}

function builtinVersion(name: string, palette: RawPalette): PaletteVersion {
  return {
    name,
    input: { energy: 'med', warmth: name === 'Evening' ? 'warm' : 'neutral', contrast: 'balanced' },
    tone: name.toLowerCase(),
    palette,
  };
}

// --- defaults --------------------------------------------------------------

export function defaultConfig(): PaletteConfig {
  return {
    defaults: {
      reviewMode: 'none',
      mood: {},
      applyScope: 'until-next-change',
    },
  };
}

export function defaultSchedule(): ScheduleConfig {
  return {
    periods: defaultPeriods(),
    assignments: {
      morning: 'Day',
      lunch: 'Day',
      afternoon: 'Day',
      evening: 'Evening',
      owl: 'Evening',
    },
    versions: {
      Day: builtinVersion('Day', dayPalette()),
      Evening: builtinVersion('Evening', eveningPalette()),
    },
    override: null,
  };
}

// --- load / save -----------------------------------------------------------

export function loadConfig(): PaletteConfig {
  const stored = readJson<PaletteConfig>(paths().config);
  if (!stored) return defaultConfig();
  // shallow-merge defaults so new fields don't crash old configs
  const d = defaultConfig();
  return {
    ...d,
    ...stored,
    defaults: { ...d.defaults, ...stored.defaults },
  };
}

export function saveConfig(cfg: PaletteConfig): void {
  writeJson(paths().config, cfg);
}

export function loadSchedule(): ScheduleConfig {
  return readJson<ScheduleConfig>(paths().schedule) ?? defaultSchedule();
}

export function saveSchedule(sched: ScheduleConfig): void {
  writeJson(paths().schedule, sched);
}

/** Ensure config + schedule exist on disk (seed on first run). Returns paths. */
export function ensureInitialized(): Paths {
  const p = paths();
  ensureDir(p.base);
  ensureDir(p.models);
  if (!existsSync(p.config)) saveConfig(defaultConfig());
  if (!existsSync(p.schedule)) saveSchedule(defaultSchedule());
  return p;
}

// --- last_regen ------------------------------------------------------------

export function readLastRegen(): Date | null {
  try {
    const raw = readFileSync(paths().lastRegen, 'utf8').trim();
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function writeLastRegen(date: Date): void {
  ensureDir(paths().base);
  writeFileSync(paths().lastRegen, `${date.toISOString()}\n`, 'utf8');
}
