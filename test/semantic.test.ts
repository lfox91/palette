import { describe, expect, test } from 'bun:test';
import { dayPalette, eveningPalette } from '../src/config.js';
import { generatePalette } from '../src/generate.js';
import { validatePalette } from '../src/validate.js';

describe('semantic role anchoring', () => {
  test('the shipped Day and Evening seeds are clean, not merely fatal-free', () => {
    for (const palette of [dayPalette(), eveningPalette()]) {
      expect(validatePalette(palette).clean).toBe(true);
    }
  });

  test('generated palettes stay within the role deviation bound across the mood grid', async () => {
    for (const energy of ['low', 'med', 'high'] as const) {
      for (const warmth of ['cool', 'neutral', 'warm'] as const) {
        for (const contrast of ['soft', 'balanced', 'vivid'] as const) {
          for (const period of ['morning', 'lunch', 'afternoon', 'evening', 'owl']) {
            const { validation } = await generatePalette({ energy, warmth, contrast }, { period });
            expect(validation.issues.filter((i) => i.kind === 'coherence')).toHaveLength(0);
          }
        }
      }
    }
  });
});
