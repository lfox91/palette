import { describe, expect, test } from 'bun:test';
import {
  clamp01,
  contrastHex,
  contrastRatio,
  deltaEOk,
  hexToOklch,
  hexToRgb,
  hueDistance,
  isValidHex,
  oklchToHex,
  pullHue,
  rgbToHex,
  wrapHue,
} from '../src/color.js';

const SRGB = ['#dc322f', '#268bd2', '#fdf6e3', '#002b36', '#8bab00', '#268bd2'];

describe('hex I/O', () => {
  test('parses short, long, and alpha forms', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(rgbToHex(hexToRgb('#000000'))).toBe('#000000');
    expect(rgbToHex(hexToRgb('#11223344'))).toBe('#112233');
    expect(rgbToHex(hexToRgb('abc'))).toBe('#aabbcc');
  });

  test('rejects malformed input', () => {
    for (const bad of ['nope', '#12345', '#gggggg', '']) {
      expect(() => hexToRgb(bad)).toThrow();
      expect(isValidHex(bad)).toBe(false);
    }
    expect(isValidHex('  #AbCdEf ')).toBe(true);
  });
});

describe('OKLCH', () => {
  test('round-trips in-gamut sRGB within one byte', () => {
    for (const hex of SRGB) {
      const a = hexToRgb(hex);
      const b = hexToRgb(oklchToHex(hexToOklch(hex)));
      expect(Math.abs(a.r - b.r)).toBeLessThanOrEqual(1 / 255);
      expect(Math.abs(a.g - b.g)).toBeLessThanOrEqual(1 / 255);
      expect(Math.abs(a.b - b.b)).toBeLessThanOrEqual(1 / 255);
    }
  });

  test('gamut-maps impossible chroma to a valid hex', () => {
    const hex = oklchToHex({ L: 0.6, C: 0.45, h: 30 });
    expect(isValidHex(hex)).toBe(true);
    const back = hexToOklch(hex);
    expect(back.C).toBeGreaterThan(0);
    expect(Number.isFinite(back.C)).toBe(true);
  });
});

describe('WCAG contrast', () => {
  test('black on white is 21:1, identical is 1:1', () => {
    expect(contrastRatio(hexToRgb('#000'), hexToRgb('#fff'))).toBeCloseTo(21, 1);
    expect(contrastHex('#123456', '#123456')).toBeCloseTo(1, 5);
  });
});

describe('perceptual helpers', () => {
  test('hueDistance takes the shortest arc', () => {
    expect(hueDistance(10, 350)).toBeCloseTo(20);
    expect(hueDistance(350, 10)).toBeCloseTo(20);
    expect(hueDistance(0, 180)).toBeCloseTo(180);
  });

  test('pullHue caps movement and wraps the result', () => {
    expect(pullHue(0, 90, 10)).toBeCloseTo(10);
    expect(pullHue(350, 10, 10)).toBeCloseTo(0);
    expect(pullHue(10, 350, 10)).toBeCloseTo(0);
    expect(pullHue(30, 30, 10)).toBeCloseTo(30);
  });

  test('deltaEOk is a metric', () => {
    expect(deltaEOk(hexToOklch('#fff'), hexToOklch('#fff'))).toBeCloseTo(0, 6);
    expect(deltaEOk(hexToOklch('#000'), hexToOklch('#fff'))).toBeGreaterThan(0.5);
  });

  test('clamp / wrap', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
    expect(wrapHue(-10)).toBe(350);
    expect(wrapHue(370)).toBe(10);
    expect(wrapHue(720)).toBe(0);
  });
});
