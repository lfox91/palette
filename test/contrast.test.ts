import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-contrast-'));

import { describe, expect, test } from 'bun:test';
import { contrastHex, hexToOklch, hueDistance } from '../src/color.js';
import { dayPalette } from '../src/config.js';
import {
  BRIGHT_CONTRAST,
  DIM_CONTRAST,
  enforceContrast,
  ensureContrast,
  NORMAL_CONTRAST,
} from '../src/contrast.js';
import { generatePalette } from '../src/generate.js';

const NORMAL = [1, 2, 3, 4, 5, 6];
const BRIGHT = [9, 10, 11, 12, 13, 14];

describe('ensureContrast', () => {
  test('returns the input untouched when it already meets the target', () => {
    expect(ensureContrast('#ffffff', '#000000', 4.5)).toBe('#ffffff');
  });

  test('darkens a pale chromatic color on light bg, preserving its hue', () => {
    const bg = '#ffffff';
    const before = '#bfdbfe'; // pale blue
    const fixed = ensureContrast(before, bg, 4.5);
    expect(contrastHex(fixed, bg)).toBeGreaterThanOrEqual(4.5);
    expect(hueDistance(hexToOklch(before).h, hexToOklch(fixed).h)).toBeLessThan(3);
  });

  test('lightens a dark color on a dark background', () => {
    const bg = '#101010';
    const fixed = ensureContrast('#202020', bg, 4.5);
    expect(contrastHex(fixed, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('enforceContrast', () => {
  test('makes the built-in Day palette legible in both schemes', () => {
    const pal = enforceContrast(dayPalette());
    for (const scheme of [pal.light, pal.dark]) {
      for (const i of NORMAL)
        expect(contrastHex(scheme.colors[i]!, scheme.background)).toBeGreaterThanOrEqual(
          NORMAL_CONTRAST - 0.01
        );
      for (const i of BRIGHT)
        expect(contrastHex(scheme.colors[i]!, scheme.background)).toBeGreaterThanOrEqual(
          BRIGHT_CONTRAST - 0.01
        );
      expect(contrastHex(scheme.colors[8]!, scheme.background)).toBeGreaterThanOrEqual(
        DIM_CONTRAST - 0.01
      );
    }
  });

  test('generated palettes are legible across the whole mood grid', async () => {
    for (const energy of ['low', 'med', 'high'] as const)
      for (const warmth of ['cool', 'neutral', 'warm'] as const)
        for (const contrast of ['soft', 'balanced', 'vivid'] as const) {
          const { palette } = await generatePalette(
            { energy, warmth, contrast },
            { period: 'evening' }
          );
          for (const scheme of [palette.light, palette.dark]) {
            for (const i of NORMAL)
              expect(contrastHex(scheme.colors[i]!, scheme.background)).toBeGreaterThanOrEqual(
                NORMAL_CONTRAST - 0.01
              );
            for (const i of BRIGHT)
              expect(contrastHex(scheme.colors[i]!, scheme.background)).toBeGreaterThanOrEqual(
                BRIGHT_CONTRAST - 0.01
              );
          }
        }
  });
});
