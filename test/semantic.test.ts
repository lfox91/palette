import { describe, expect, test } from 'bun:test';
import { dayPalette } from '../src/config.js';
import { generatePalette } from '../src/generate.js';
import { validatePalette } from '../src/validate.js';

describe('semantic role anchoring', () => {
  test('the built-in seed surfaces its hue-role conflict instead of hiding it', () => {
    const coherence = validatePalette(dayPalette()).issues.filter((i) => i.kind === 'coherence');
    expect(coherence.length).toBeGreaterThan(0);
    expect(coherence.every((i) => !i.fatal)).toBe(true);
  });

  test('generated palettes stay within the role deviation bound in every period', async () => {
    for (const period of ['morning', 'lunch', 'afternoon', 'evening', 'owl']) {
      const { validation } = await generatePalette(
        { energy: 'med', warmth: 'neutral', contrast: 'balanced' },
        { period }
      );
      expect(validation.issues.filter((i) => i.kind === 'coherence')).toHaveLength(0);
    }
  });
});
