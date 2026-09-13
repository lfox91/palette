/** Shared domain types for palette generation, scheduling, and config. */

// --- mood input ------------------------------------------------------------

export type Energy = 'low' | 'med' | 'high';
export type Warmth = 'cool' | 'neutral' | 'warm';
export type Contrast = 'soft' | 'balanced' | 'vivid';

export interface MoodInput {
  energy: Energy;
  warmth: Warmth;
  contrast: Contrast;
  /** optional free-text note, mapped against a word->hue dictionary */
  note?: string;
}

// --- palette ---------------------------------------------------------------

/** The 16 ANSI slots + fg/bg/cursor, as hex. This is one scheme (light OR dark). */
export interface Scheme {
  foreground: string;
  background: string;
  cursor: string;
  /** ANSI 0..15 */
  colors: string[]; // length 16
}

/** A full generated palette: both light and dark schemes. */
export interface RawPalette {
  light: Scheme;
  dark: Scheme;
}

/**
 * A named, stored palette "version" — the source of truth for a period's colors.
 * Generation is random+bounded, so we store the RESULTING colors, not a seed to
 * re-derive them. `input` is kept only for context (re-review, display).
 */
export interface PaletteVersion {
  name: string;
  /** the mood it was generated from — context only, NOT a recipe to reproduce */
  input: MoodInput;
  /** the period tone it was generated under, if any (context only) */
  tone?: string;
  palette: RawPalette;
  /** ISO-ish stamp set by the CLI at save time (scripts pass it in) */
  createdAt?: string;
}

/**
 * A tone window: how a period shifts the shade RANGES (not the exact shade).
 * "up early" widens/raises the background lightness range (whiter mornings);
 * evening warms and dims; owl darkens. The exact shade inside the shifted range
 * is still chosen at random.
 */
export interface ToneWindow {
  name: string;
  /** additive lightness bias applied to background/gray shades (whiter = +) */
  bgL: number;
  /** additive lightness bias applied to chromatic accents */
  accentL: number;
  /** multiplier on accent chroma (dimmer at night = <1) */
  chroma: number;
  /** pull of neutral tint toward the warm pole, in degrees (warm evenings = +) */
  warmth: number;
}

// --- periods ---------------------------------------------------------------

export type SolarAnchor = 'sunrise' | 'noon' | 'sunset';

export type Trigger =
  | { kind: 'clock'; time: string } // "HH:MM"
  | { kind: 'solar'; anchor: SolarAnchor; offsetMin: number };

export interface Period {
  name: string;
  trigger: Trigger;
  /** built-ins can only be disabled (soft-delete); custom periods hard-delete */
  builtin: boolean;
  enabled: boolean;
}

// --- review ----------------------------------------------------------------

export type ReviewMode = 'none' | 'local' | 'remote' | 'plugin';

/** A reviewer's response: approve as-is, or propose slot tweaks. */
export interface PaletteSuggestion {
  approved: boolean;
  /** human-readable rationale */
  rationale: string;
  /** proposed changes; each is a scheme+slot -> new hex */
  tweaks: SlotTweak[];
}

export interface SlotTweak {
  scheme: 'light' | 'dark';
  /** 'foreground' | 'background' | 'cursor' | 'color0'..'color15' */
  slot: string;
  hex: string;
  reason: string;
}

// --- config ----------------------------------------------------------------

export interface PaletteConfig {
  defaults: {
    reviewMode: ReviewMode;
    /** picklist defaults so dialogs can be skipped */
    mood: Partial<MoodInput>;
    /** the pinned plugin id when reviewMode is 'plugin' */
    pluginId?: string;
    /** default apply-scope for the bare `palette` command */
    applyScope: 'all-times' | 'until-next-change';
  };
  /** local review model path (absolute), if configured */
  modelPath?: string;
  /** remote review provider config; API key resolved from env at call time */
  remote?: {
    provider: 'anthropic' | 'openai-compatible';
    baseUrl?: string;
    model?: string;
    apiKeyEnv?: string; // env var name, not the key itself
  };
}

/** schedule.json: the period->version map + saved named versions. */
export interface ScheduleConfig {
  periods: Period[];
  /** period name -> version name */
  assignments: Record<string, string>;
  /** version name -> stored version */
  versions: Record<string, PaletteVersion>;
  /** a temporary "until next change" override, cleared at the next boundary */
  override?: {
    versionName: string;
    setAt: string;
  } | null;
}

export const MANAGED_PALETTE_NAME = 'Sundial';
