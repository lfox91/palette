import { describe, expect, test } from 'bun:test';
import { deltaEOk, type Oklch, oklchToHex } from '../src/color.js';
import { dayPalette } from '../src/config.js';
import { separationThreshold, validatePalette } from '../src/validate.js';

describe('chroma-aware separation threshold', () => {
  test('scales with the pair chroma, floored and capped', () => {
    const vivid = separationThreshold({ L: 0.7, C: 0.12, h: 0 }, { L: 0.7, C: 0.12, h: 40 });
    const muted = separationThreshold({ L: 0.7, C: 0.05, h: 0 }, { L: 0.7, C: 0.05, h: 40 });
    const grey = separationThreshold({ L: 0.7, C: 0.002, h: 0 }, { L: 0.7, C: 0.002, h: 40 });
    expect(vivid).toBeCloseTo(0.06, 5);
    expect(muted).toBeCloseTo(0.025, 5);
    expect(grey).toBeCloseTo(0.02, 5);
  });

  test('a muted pair the old fixed rule rejected now passes', () => {
    const a: Oklch = { L: 0.72, C: 0.03, h: 142 };
    const b: Oklch = { L: 0.72, C: 0.03, h: 100 };
    const d = deltaEOk(a, b);
    expect(d).toBeLessThan(0.06);
    expect(d).toBeGreaterThanOrEqual(separationThreshold(a, b));

    const p = dayPalette();
    const dark = { ...p.dark, colors: [...p.dark.colors] };
    dark.colors[2] = oklchToHex(a);
    dark.colors[3] = oklchToHex(b);
    const res = validatePalette({ ...p, dark });
    expect(res.issues.some((i) => i.message.includes('color2 and color3'))).toBe(false);
  });
});
