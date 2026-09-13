/**
 * Optional post-generation review. Generation is ALWAYS code (the bounded
 * heuristic + validator); the model — if any — only reviews the finished
 * palette and proposes specific slot tweaks, shown to the user as a diff to
 * accept or reject. It can never originate a color or bypass validatePalette:
 * every accepted tweak is re-validated here.
 *
 * Three backends behind one interface:
 *   none   — no-op approval (default; instant, offline)
 *   local  — node-llama-cpp + a small GGUF (offline)
 *   remote — BYO API key (Anthropic / OpenAI-compatible; the only networked one)
 */

import { isValidHex } from '../color.js';
import { hashText } from '../hash.js';
import type {
  MoodInput,
  PaletteConfig,
  PaletteSuggestion,
  RawPalette,
  ReviewMode,
  Scheme,
  SlotTweak,
} from '../types.js';
import { type ValidationResult, validatePalette } from '../validate.js';

export interface ReviewBackend {
  readonly mode: ReviewMode;
  review(palette: RawPalette, input: MoodInput): Promise<PaletteSuggestion>;
}

// --- shared prompt + parsing (used by local and remote) --------------------

/** Bump when the reviewer prompt changes — benchmark runs pin this. */
export const REVIEW_PROMPT_VERSION = 1;

const PROMPT_HEADER = [
  'You are a terminal color-palette reviewer. A palette has already been generated',
  'by a constraint-based engine and passed contrast/spacing validation. Your job is',
  'to review it against the requested mood and EITHER approve it as-is OR propose a',
  'few specific slot tweaks that make it read more true to the mood. Be conservative:',
  'suggest a change only when confident it improves the fit. Never redesign it.',
  '',
  'Slots are: "foreground", "background", "cursor", and "color0".."color15"',
  '(ANSI: 0 black,1 red,2 green,3 yellow,4 blue,5 magenta,6 cyan,7 white, 8-15 bright).',
  'Each scheme is "light" or "dark". Colors are "#rrggbb".',
].join('\n');

const PROMPT_SCHEMA = [
  'Respond with ONLY a JSON object, no prose, matching exactly:',
  '{"approved": boolean, "rationale": string, "tweaks": [',
  '  {"scheme":"light"|"dark","slot":string,"hex":"#rrggbb","reason":string} ]}',
  'If approved, use an empty tweaks array.',
].join('\n');

export function buildReviewPrompt(palette: RawPalette, input: MoodInput): string {
  return [
    PROMPT_HEADER,
    '',
    `Mood: ${JSON.stringify(input)}`,
    `Palette: ${JSON.stringify(palette)}`,
    '',
    PROMPT_SCHEMA,
  ].join('\n');
}

/** Stable hash of the reviewer prompt (version + static instructions). */
export function reviewPromptHash(): string {
  return hashText(`${REVIEW_PROMPT_VERSION}:${PROMPT_HEADER}\n${PROMPT_SCHEMA}`);
}

/** Robustly extract the suggestion JSON from a model response. */
export function parseSuggestion(text: string): PaletteSuggestion {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return { approved: true, rationale: 'reviewer returned no parseable suggestion', tweaks: [] };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { approved: true, rationale: 'reviewer returned invalid JSON', tweaks: [] };
  }
  const o = obj as Record<string, unknown>;
  const rawTweaks = Array.isArray(o.tweaks) ? o.tweaks : [];
  const tweaks: SlotTweak[] = rawTweaks
    .map((t): SlotTweak | null => {
      const r = t as Record<string, unknown>;
      if ((r.scheme !== 'light' && r.scheme !== 'dark') || typeof r.slot !== 'string') return null;
      if (typeof r.hex !== 'string' || !isValidHex(r.hex) || !isValidSlot(r.slot)) return null;
      return {
        scheme: r.scheme,
        slot: r.slot,
        hex: normalizeHex(r.hex),
        reason: typeof r.reason === 'string' ? r.reason : '',
      };
    })
    .filter((t): t is SlotTweak => t !== null);
  return {
    approved: o.approved === true && tweaks.length === 0,
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
    tweaks,
  };
}

// --- applying tweaks (with mandatory re-validation) ------------------------

const SLOT_RE = /^(foreground|background|cursor|color([0-9]|1[0-5]))$/;

export function isValidSlot(slot: string): boolean {
  return SLOT_RE.test(slot);
}

function normalizeHex(hex: string): string {
  const s = hex.trim().toLowerCase();
  return s.startsWith('#') ? s : `#${s}`;
}

function setSlot(scheme: Scheme, slot: string, hex: string): Scheme {
  const next: Scheme = { ...scheme, colors: [...scheme.colors] };
  if (slot === 'foreground') next.foreground = hex;
  else if (slot === 'background') next.background = hex;
  else if (slot === 'cursor') next.cursor = hex;
  else next.colors[Number.parseInt(slot.slice(5), 10)] = hex;
  return next;
}

/** Apply one tweak to a palette, returning a new palette (pure). */
export function applyTweak(palette: RawPalette, tweak: SlotTweak): RawPalette {
  const target = tweak.scheme === 'light' ? palette.light : palette.dark;
  const updated = setSlot(target, tweak.slot, tweak.hex);
  return tweak.scheme === 'light' ? { ...palette, light: updated } : { ...palette, dark: updated };
}

/**
 * Apply a set of accepted tweaks and re-validate. The plan's guarantee: an
 * accepted suggestion is re-run through validatePalette; if it introduces a
 * fatal issue, it is rejected. Returns the resulting palette (only tweaks that
 * keep the palette fatal-free are kept) and the final validation.
 */
export function applyTweaks(
  palette: RawPalette,
  tweaks: SlotTweak[]
): {
  palette: RawPalette;
  applied: SlotTweak[];
  rejected: SlotTweak[];
  validation: ValidationResult;
} {
  let current = palette;
  const applied: SlotTweak[] = [];
  const rejected: SlotTweak[] = [];
  for (const tweak of tweaks) {
    const candidate = applyTweak(current, tweak);
    if (validatePalette(candidate).ok) {
      current = candidate;
      applied.push(tweak);
    } else {
      rejected.push(tweak); // would break safety/structure — never applied
    }
  }
  return { palette: current, applied, rejected, validation: validatePalette(current) };
}

// --- backend resolution -----------------------------------------------------

export async function getReviewer(config: PaletteConfig): Promise<ReviewBackend> {
  const mode = config.defaults.reviewMode;
  if (mode === 'none') return (await import('./none.js')).noneReviewer;
  if (mode === 'local') return (await import('./local.js')).makeLocalReviewer(config);
  if (mode === 'plugin') return (await import('../plugin-reviewer.js')).makePluginReviewer(config);
  return (await import('./remote.js')).makeRemoteReviewer(config);
}
