import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-gen-'));
process.env.PALETTE_NO_SYSTEMCTL = '1';

import { describe, expect, test } from 'bun:test';
import { deriveHeuristic } from '../src/derive/heuristic.js';
import { generatePalette } from '../src/generate.js';
import { selectPalette } from '../src/ranges.js';
import { makeRng } from '../src/rng.js';
import { toneFor } from '../src/tone.js';
import type { Contrast, Energy, RawPalette, Warmth } from '../src/types.js';

const HEX = /^#[0-9a-f]{6}$/;

describe('range selection', () => {
  test('is deterministic for a given seed', () => {
    const mood = { energy: 'high', warmth: 'cool', contrast: 'vivid' } as const;
    const specA = deriveHeuristic(mood, toneFor('evening'), makeRng(42));
    const specB = deriveHeuristic(mood, toneFor('evening'), makeRng(42));
    const palA = selectPalette(specA, makeRng(7));
    const palB = selectPalette(specB, makeRng(7));
    expect(palA).toEqual(palB);
  });

  test('every slot is a complete, valid scheme', () => {
    const spec = deriveHeuristic(
      { energy: 'med', warmth: 'neutral', contrast: 'balanced' },
      toneFor('afternoon'),
      makeRng(1)
    );
    const pal = selectPalette(spec, makeRng(2));
    for (const scheme of [pal.light, pal.dark]) {
      expect(scheme.colors).toHaveLength(16);
      for (const c of [scheme.foreground, scheme.background, scheme.cursor, ...scheme.colors]) {
        expect(c).toMatch(HEX);
      }
    }
  });
});

describe('generatePalette', () => {
  test('never returns a fatal palette across the mood grid', async () => {
    const energies: Energy[] = ['low', 'med', 'high'];
    const warms: Warmth[] = ['cool', 'neutral', 'warm'];
    const contrasts: Contrast[] = ['soft', 'balanced', 'vivid'];
    for (const energy of energies) {
      for (const warmth of warms) {
        for (const contrast of contrasts) {
          const { validation } = await generatePalette(
            { energy, warmth, contrast },
            { period: 'afternoon' }
          );
          expect(validation.ok).toBe(true);
        }
      }
    }
  });

  test('tone windows produce clean palettes, not merely fatal-free ones', async () => {
    for (const period of ['morning', 'lunch', 'afternoon', 'evening', 'owl', 'custom']) {
      const { validation } = await generatePalette(
        { energy: 'med', warmth: 'neutral', contrast: 'balanced' },
        { period }
      );
      expect(validation.clean).toBe(true);
    }
  });

  test('the whole mood grid is clean, not merely fatal-free', async () => {
    for (const energy of ['low', 'med', 'high'] as const) {
      for (const warmth of ['cool', 'neutral', 'warm'] as const) {
        for (const contrast of ['soft', 'balanced', 'vivid'] as const) {
          const { validation } = await generatePalette(
            { energy, warmth, contrast },
            { period: 'afternoon' }
          );
          expect(validation.clean).toBe(true);
        }
      }
    }
  });

  test('output is structurally complete', async () => {
    const { palette } = await generatePalette({
      energy: 'high',
      warmth: 'warm',
      contrast: 'vivid',
    });
    const check = (pal: RawPalette) => {
      expect(pal.light.colors).toHaveLength(16);
      expect(pal.dark.colors).toHaveLength(16);
    };
    check(palette);
  });
});
