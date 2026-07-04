/**
 * The `none` (offline, no-AI) deriver.
 *
 * It converts the heuristics (mood + period tone) into a RangeSpec using a set
 * of PREALLOCATED GROUPINGS — curated (color-theory, cast-hue) clusters known to
 * work together. To keep it interesting, code selects among the well-fitting
 * groupings at random, and a cast hue from the grouping at random. The exact
 * shade is chosen later by the selector; this deriver only sets the ranges.
 *
 * Color theory maps to mood via a HARMONY level: calm/moody moods are highly
 * harmonious (analogous / monochromatic), angry/energetic moods are less so
 * (complementary / triadic, clashing). Semantics are always preserved — theory
 * shapes chroma, cast, cursor emphasis and hue-pull, NEVER the ANSI identities
 * (color1 stays red, etc.), so a "monochromatic" mood desaturates accents toward
 * the cast rather than repainting them.
 */

import { pullHue } from '../color.js';
import { band, hueBand, type RangeSpec, type SchemeRanges, type SlotRange } from '../ranges.js';
import type { Rng } from '../rng.js';
import type { Contrast, Energy, MoodInput, ToneWindow, Warmth } from '../types.js';

export type Theory = 'monochromatic' | 'analogous' | 'complementary' | 'split' | 'triadic';

interface Grouping {
  name: string;
  theory: Theory;
  /** candidate dominant hues (deg); one chosen at random per generation */
  castHues: number[];
  warmthAffinity: Warmth | 'any';
  energyAffinity: Energy | 'any';
  /** 0 = clashing, 1 = maximally harmonious (drives hue spread + pull) */
  harmony: number;
}

// The preallocated groupings. Each is a curated color-theory idea with cast-hue
// candidates and a mood affinity. Ordered loosely cool -> warm.
const GROUPINGS: Grouping[] = [
  {
    name: 'slate',
    theory: 'monochromatic',
    castHues: [250, 260, 235],
    warmthAffinity: 'cool',
    energyAffinity: 'low',
    harmony: 0.85,
  },
  {
    name: 'moody',
    theory: 'monochromatic',
    castHues: [258, 270, 220],
    warmthAffinity: 'cool',
    energyAffinity: 'med',
    harmony: 0.8,
  },
  {
    name: 'tide',
    theory: 'analogous',
    castHues: [200, 215, 185],
    warmthAffinity: 'cool',
    energyAffinity: 'med',
    harmony: 0.8,
  },
  {
    name: 'storm',
    theory: 'split',
    castHues: [245, 260],
    warmthAffinity: 'cool',
    energyAffinity: 'high',
    harmony: 0.4,
  },
  {
    name: 'electric',
    theory: 'triadic',
    castHues: [270, 210, 300],
    warmthAffinity: 'cool',
    energyAffinity: 'high',
    harmony: 0.3,
  },
  {
    name: 'forest',
    theory: 'analogous',
    castHues: [140, 150, 160],
    warmthAffinity: 'neutral',
    energyAffinity: 'med',
    harmony: 0.7,
  },
  {
    name: 'mineral',
    theory: 'monochromatic',
    castHues: [150, 200, 90],
    warmthAffinity: 'neutral',
    energyAffinity: 'low',
    harmony: 0.8,
  },
  {
    name: 'hearth',
    theory: 'analogous',
    castHues: [40, 55, 30],
    warmthAffinity: 'warm',
    energyAffinity: 'low',
    harmony: 0.85,
  },
  {
    name: 'bloom',
    theory: 'complementary',
    castHues: [350, 10, 330],
    warmthAffinity: 'warm',
    energyAffinity: 'med',
    harmony: 0.5,
  },
  {
    name: 'ember',
    theory: 'complementary',
    castHues: [30, 45, 20],
    warmthAffinity: 'warm',
    energyAffinity: 'high',
    harmony: 0.35,
  },
];

// Note words -> hue hint (cast preference). Multiple hits are averaged.
const WORD_HUE: Record<string, number> = {
  fire: 29,
  ember: 35,
  rust: 40,
  blood: 25,
  rose: 10,
  ruby: 20,
  brick: 38,
  amber: 70,
  sand: 80,
  desert: 75,
  autumn: 60,
  clay: 55,
  terracotta: 50,
  gold: 95,
  sun: 100,
  honey: 92,
  wheat: 98,
  lemon: 105,
  forest: 145,
  moss: 135,
  leaf: 140,
  mint: 160,
  sage: 150,
  emerald: 155,
  pine: 148,
  ocean: 210,
  sea: 205,
  teal: 190,
  aqua: 195,
  water: 215,
  lagoon: 200,
  sky: 240,
  ice: 250,
  azure: 255,
  midnight: 275,
  cobalt: 265,
  steel: 245,
  storm: 258,
  violet: 300,
  lavender: 295,
  plum: 330,
  orchid: 340,
  dusk: 285,
  twilight: 288,
  berry: 350,
};

// Note words -> mood hints that bias harmony / theory / energy.
interface MoodHint {
  harmony?: number; // absolute target 0..1
  theory?: Theory;
  hue?: number;
  energy?: Energy;
}
const WORD_MOOD: Record<string, MoodHint> = {
  angry: { harmony: 0.2, theory: 'complementary', energy: 'high', hue: 28 },
  rage: { harmony: 0.15, theory: 'triadic', energy: 'high', hue: 25 },
  tense: { harmony: 0.3, theory: 'split', energy: 'high' },
  moody: { harmony: 0.82, theory: 'monochromatic', hue: 258 },
  calm: { harmony: 0.9, theory: 'analogous', energy: 'low' },
  quiet: { harmony: 0.88, theory: 'monochromatic', energy: 'low' },
  cozy: { harmony: 0.85, theory: 'analogous', hue: 45, energy: 'low' },
  cheerful: { harmony: 0.55, theory: 'analogous', energy: 'high', hue: 90 },
  playful: { harmony: 0.4, theory: 'triadic', energy: 'high' },
  focused: { harmony: 0.75, theory: 'monochromatic', energy: 'med' },
  dreamy: { harmony: 0.8, theory: 'analogous', hue: 290, energy: 'low' },
};

// --- theory -> accent treatment -------------------------------------------

interface TheoryParams {
  /** max degrees an accent is pulled toward the cast (semantics-preserving cap) */
  accentPull: number;
  /** multiplier on accent chroma (mono desaturates, triadic saturates) */
  chromaScale: number;
  /** cursor emphasis hue offset(s) from cast; array = pick one at random */
  cursorOffset: number | number[];
}

function theoryParams(theory: Theory): TheoryParams {
  switch (theory) {
    case 'monochromatic':
      return { accentPull: 18, chromaScale: 0.55, cursorOffset: 0 };
    case 'analogous':
      return { accentPull: 12, chromaScale: 0.82, cursorOffset: [30, -30] };
    case 'complementary':
      return { accentPull: 7, chromaScale: 1.05, cursorOffset: 180 };
    case 'split':
      return { accentPull: 7, chromaScale: 1.0, cursorOffset: [150, -150] };
    case 'triadic':
      return { accentPull: 5, chromaScale: 1.12, cursorOffset: [120, -120] };
  }
}

// --- mood scalars ----------------------------------------------------------

function energyChroma(e: Energy): number {
  return e === 'high' ? 0.16 : e === 'med' ? 0.12 : 0.09;
}

/** fg/bg lightness anchors from contrast + scheme polarity. */
function toneAnchors(contrast: Contrast, dark: boolean): { bgL: number; fgL: number } {
  const gap = contrast === 'vivid' ? 0.82 : contrast === 'balanced' ? 0.74 : 0.66;
  if (dark) {
    const bgL = contrast === 'vivid' ? 0.16 : contrast === 'balanced' ? 0.19 : 0.23;
    return { bgL, fgL: Math.min(0.97, bgL + gap) };
  }
  const bgL = contrast === 'vivid' ? 0.97 : contrast === 'balanced' ? 0.95 : 0.93;
  return { bgL, fgL: Math.max(0.22, bgL - gap) };
}

// --- note parsing ----------------------------------------------------------

interface NoteSignal {
  castHint?: number;
  hints: MoodHint[];
}

function parseNote(note: string | undefined): NoteSignal {
  if (!note) return { hints: [] };
  const words = note
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const hues: number[] = [];
  const hints: MoodHint[] = [];
  for (const w of words) {
    if (WORD_HUE[w] !== undefined) hues.push(WORD_HUE[w]!);
    if (WORD_MOOD[w]) {
      hints.push(WORD_MOOD[w]!);
      if (WORD_MOOD[w]!.hue !== undefined) hues.push(WORD_MOOD[w]!.hue!);
    }
  }
  return { castHint: hues.length ? averageHue(hues) : undefined, hints };
}

function averageHue(hues: number[]): number {
  let x = 0;
  let y = 0;
  for (const h of hues) {
    x += Math.cos((h * Math.PI) / 180);
    y += Math.sin((h * Math.PI) / 180);
  }
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// --- grouping selection ----------------------------------------------------

function scoreGrouping(g: Grouping, m: MoodInput, note: NoteSignal): number {
  let s = 1;
  if (g.warmthAffinity === m.warmth) s += 2;
  else if (g.warmthAffinity === 'any') s += 1;
  if (g.energyAffinity === m.energy) s += 2;
  else if (g.energyAffinity === 'any') s += 1;
  // note theory hints
  for (const h of note.hints) {
    if (h.theory && h.theory === g.theory) s += 2;
    if (h.harmony !== undefined) s += 1 - Math.abs(h.harmony - g.harmony) * 2;
  }
  // note cast-hue proximity: reward groupings whose cast candidates sit near it
  if (note.castHint !== undefined) {
    const nearest = Math.min(...g.castHues.map((c) => hueDist(c, note.castHint!)));
    s += Math.max(0, 1.5 - nearest / 60);
  }
  return s;
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

function chooseGrouping(m: MoodInput, note: NoteSignal, rng: Rng): Grouping {
  const scored = GROUPINGS.map((g) => ({ g, s: scoreGrouping(g, m, note) }));
  const best = Math.max(...scored.map((x) => x.s));
  // pick randomly among groupings within 1.0 of the best score (variety)
  const pool = scored.filter((x) => x.s >= best - 1.0).map((x) => x.g);
  return rng.pick(pool);
}

// --- range construction ----------------------------------------------------

const ANSI_HUE: Record<number, number> = { 1: 29, 2: 142, 3: 100, 4: 264, 5: 328, 6: 195 };
const HUE_CHROMA_WEIGHT: Record<number, number> = { 2: 0.92, 3: 0.82 };

function buildScheme(
  m: MoodInput,
  tone: ToneWindow,
  castHue: number,
  tp: TheoryParams,
  harmony: number,
  dark: boolean,
  rng: Rng
): SchemeRanges {
  const { bgL, fgL } = toneAnchors(m.contrast, dark);
  const bgLc = clamp(bgL + tone.bgL, dark ? 0.1 : 0.85, dark ? 0.32 : 0.99);
  const fgLc = clamp(fgL + (dark ? tone.bgL * 0.3 : -tone.bgL * 0.3), 0.15, 0.98);

  // neutral tint: cast hue, pulled slightly toward the warm pole in warm tones
  const neutralHue = pullHue(castHue, 60, tone.warmth * 0.4);
  const neutralC = m.contrast === 'vivid' ? 0.02 : m.contrast === 'balanced' ? 0.014 : 0.01;

  const accentC = energyChroma(m.energy) * tp.chromaScale * tone.chroma;
  const accentL = (dark ? 0.72 : 0.55) + tone.accentL;
  // hue spread grows as harmony falls (clashing palettes let hues wander more)
  const spread = 2 + (1 - harmony) * 6;

  const colors: SlotRange[] = new Array(16);

  // grays / structural
  colors[0] = {
    L: band(dark ? bgLc + 0.02 : bgLc - 0.06, 0.015),
    C: band(neutralC * 1.4, 0.005),
    h: hueBand(neutralHue, 6),
  };
  colors[8] = {
    L: band(dark ? bgLc + 0.18 : bgLc - 0.24, 0.02),
    C: band(neutralC * 1.4, 0.005),
    h: hueBand(neutralHue, 6),
  };
  colors[7] = {
    L: band(dark ? fgLc - 0.12 : fgLc + 0.1, 0.02),
    C: band(neutralC * 1.2, 0.005),
    h: hueBand(neutralHue, 6),
  };
  colors[15] = {
    L: band(dark ? Math.min(0.98, fgLc + 0.06) : Math.max(0.2, fgLc - 0.04), 0.015),
    C: band(neutralC, 0.004),
    h: hueBand(neutralHue, 6),
  };

  for (const i of [1, 2, 3, 4, 5, 6]) {
    const center = pullHue(ANSI_HUE[i]!, castHue, tp.accentPull);
    const w = HUE_CHROMA_WEIGHT[i] ?? 1;
    colors[i] = {
      L: band(accentL, 0.025, 0.2, dark ? 0.85 : 0.7),
      C: band(accentC * w, 0.01, 0.01),
      h: hueBand(center, spread),
    };
    colors[i + 8] = {
      L: band(Math.min(dark ? 0.86 : 0.68, accentL + 0.1), 0.02, 0.2, 0.9),
      C: band(accentC * w + 0.01, 0.01, 0.01),
      h: hueBand(center, spread * 0.7),
    };
  }

  // cursor: theory emphasis hue
  const off = Array.isArray(tp.cursorOffset) ? rng.pick(tp.cursorOffset) : tp.cursorOffset;
  const cursorHue = (((castHue + off) % 360) + 360) % 360;

  return {
    background: {
      L: band(bgLc, 0.02, dark ? 0.08 : 0.84, dark ? 0.34 : 1),
      C: band(neutralC, 0.006),
      h: hueBand(neutralHue, 6),
    },
    foreground: { L: band(fgLc, 0.02), C: band(neutralC * 0.7, 0.004), h: hueBand(neutralHue, 6) },
    cursor: {
      L: band(accentL, 0.03, 0.2, dark ? 0.88 : 0.72),
      C: band(accentC * 0.95, 0.012, 0.02),
      h: hueBand(cursorHue, spread),
    },
    colors,
  };
}

/**
 * Derive a RangeSpec from mood + tone using the preallocated groupings and
 * color-theory-per-mood. Uses `rng` for grouping/cast/emphasis variety; the
 * per-shade randomness happens later in the selector.
 */
export function deriveHeuristic(input: MoodInput, tone: ToneWindow, rng: Rng): RangeSpec {
  const note = parseNote(input.note);

  // effective harmony/theory can be nudged by note mood hints
  const g = chooseGrouping(input, note, rng);
  let theory = g.theory;
  let harmony = g.harmony;
  for (const h of note.hints) {
    if (h.theory) theory = h.theory;
    if (h.harmony !== undefined) harmony = h.harmony;
  }

  // cast hue: prefer the note's hint if given, else a random candidate
  const castHue = note.castHint !== undefined ? note.castHint : rng.pick(g.castHues);
  const tp = theoryParams(theory);

  return {
    dark: buildScheme(input, tone, castHue, tp, harmony, true, rng),
    light: buildScheme(input, tone, castHue, tp, harmony, false, rng),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
