/**
 * Color math: sRGB <-> OKLab <-> OKLCH, hex parsing/formatting, WCAG contrast,
 * and perceptual distance. All generation and validation works in OKLCH; hex is
 * only an I/O format (Ptyxis .palette files store `#RRGGBB`).
 *
 * OKLab reference: Björn Ottosson, https://bottosson.github.io/posts/oklab/
 */

export interface Rgb {
  /** 0..1 */ r: number;
  /** 0..1 */ g: number;
  /** 0..1 */ b: number;
}

export interface Oklch {
  /** perceptual lightness, 0..1 */ L: number;
  /** chroma, 0..~0.4 */ C: number;
  /** hue in degrees, 0..360 */ h: number;
}

// --- hex I/O ---------------------------------------------------------------

/** Parse `#RGB`, `#RRGGBB`, or `#RRGGBBAA` (alpha ignored) into linear-ready sRGB 0..1. */
export function hexToRgb(hex: string): Rgb {
  const s = hex.trim().replace(/^#/, '');
  let r: number;
  let g: number;
  let b: number;
  if (s.length === 3) {
    r = Number.parseInt(s[0]! + s[0]!, 16);
    g = Number.parseInt(s[1]! + s[1]!, 16);
    b = Number.parseInt(s[2]! + s[2]!, 16);
  } else if (s.length === 6 || s.length === 8) {
    r = Number.parseInt(s.slice(0, 2), 16);
    g = Number.parseInt(s.slice(2, 4), 16);
    b = Number.parseInt(s.slice(4, 6), 16);
  } else {
    throw new Error(`invalid hex color: ${hex}`);
  }
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`invalid hex color: ${hex}`);
  }
  return { r: r / 255, g: g / 255, b: b / 255 };
}

const HEX_RE = /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$|^#?[0-9a-fA-F]{8}$/;

export function isValidHex(hex: string): boolean {
  return HEX_RE.test(hex.trim());
}

function toByte(v: number): string {
  const n = Math.round(clamp01(v) * 255);
  return n.toString(16).padStart(2, '0');
}

/** Format sRGB 0..1 as `#RRGGBB`. */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

// --- sRGB <-> linear -------------------------------------------------------

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

// --- linear sRGB <-> OKLab (Ottosson matrices) -----------------------------

interface Oklab {
  L: number;
  a: number;
  b: number;
}

function linearRgbToOklab(r: number, g: number, b: number): Oklab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function oklabToLinearRgb({ L, a, b }: Oklab): Rgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

// --- public OKLCH conversions ---------------------------------------------

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lab = linearRgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
  const C = Math.hypot(lab.a, lab.b);
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L: lab.L, C, h };
}

/** Convert OKLCH to sRGB WITHOUT gamut mapping (may be out of [0,1]). */
function oklchToRgbRaw({ L, C, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const lab: Oklab = { L, a: C * Math.cos(hr), b: C * Math.sin(hr) };
  const lin = oklabToLinearRgb(lab);
  return {
    r: linearToSrgb(lin.r),
    g: linearToSrgb(lin.g),
    b: linearToSrgb(lin.b),
  };
}

function inGamut(rgb: Rgb): boolean {
  const eps = 1e-4;
  return (
    rgb.r >= -eps &&
    rgb.r <= 1 + eps &&
    rgb.g >= -eps &&
    rgb.g <= 1 + eps &&
    rgb.b >= -eps &&
    rgb.b <= 1 + eps
  );
}

/**
 * Convert OKLCH to sRGB, gamut-mapping by reducing chroma (binary search) so
 * hue and lightness are preserved as much as possible. This is what makes
 * "place every slot in perceptual space" safe: we never emit an invalid color.
 */
export function oklchToRgb(color: Oklch): Rgb {
  const direct = oklchToRgbRaw(color);
  if (inGamut(direct)) return clampRgb(direct);

  let lo = 0;
  let hi = color.C;
  let result = oklchToRgbRaw({ ...color, C: 0 });
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const candidate = oklchToRgbRaw({ ...color, C: mid });
    if (inGamut(candidate)) {
      result = candidate;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return clampRgb(result);
}

export function oklchToHex(color: Oklch): string {
  return rgbToHex(oklchToRgb(color));
}

export function hexToOklch(hex: string): Oklch {
  return rgbToOklch(hexToRgb(hex));
}

// --- WCAG contrast ---------------------------------------------------------

/** Relative luminance per WCAG 2.1. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio (1..21) between two colors. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function contrastHex(a: string, b: string): number {
  return contrastRatio(hexToRgb(a), hexToRgb(b));
}

// --- perceptual distance ---------------------------------------------------

/**
 * OKLab Euclidean distance — a good perceptual ΔE proxy. Used by the aesthetic
 * gate to keep ANSI slots visually distinct.
 */
export function deltaEOk(a: Oklch, b: Oklch): number {
  const ha = (a.h * Math.PI) / 180;
  const hb = (b.h * Math.PI) / 180;
  const aa = a.C * Math.cos(ha);
  const ab = a.C * Math.sin(ha);
  const ba = b.C * Math.cos(hb);
  const bb = b.C * Math.sin(hb);
  return Math.hypot(a.L - b.L, aa - ba, ab - bb);
}

/** Smallest angular distance between two hues, 0..180. */
export function hueDistance(h1: number, h2: number): number {
  const d = Math.abs(((h1 - h2) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

// --- helpers ---------------------------------------------------------------

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRgb({ r, g, b }: Rgb): Rgb {
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b) };
}

/** Wrap a hue into [0, 360). */
export function wrapHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/**
 * Move hue `from` toward hue `toward` along the shorter arc, by at most
 * `maxDeg` degrees. Used to pull ANSI accents toward the mood's cast while
 * keeping their identity (a small, bounded nudge — red stays red).
 */
export function pullHue(from: number, toward: number, maxDeg: number): number {
  let diff = ((toward - from + 540) % 360) - 180; // shortest signed arc [-180,180]
  diff = Math.max(-maxDeg, Math.min(maxDeg, diff));
  return wrapHue(from + diff);
}
