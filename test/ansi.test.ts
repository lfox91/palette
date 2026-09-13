import { describe, expect, test } from 'bun:test';
import { ANSI_HUE, ANSI_HUE_MAX_DEVIATION, ANSI_ROLES, chromaName } from '../src/ansi.js';

describe('ANSI semantic contract', () => {
  test('covers all 16 slots with roles', () => {
    expect(ANSI_ROLES).toHaveLength(16);
    expect(ANSI_ROLES.map((r) => r.slot)).toEqual([...Array(16).keys()]);
  });

  test('chromatic slots carry canonical hues; bright twins share the role name', () => {
    expect(
      Object.keys(ANSI_HUE)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chromaName(5)).toBe('magenta');
    expect(chromaName(13)).toBe('bright magenta');
    expect(chromaName(0)).toBe('black');
    expect(ANSI_HUE_MAX_DEVIATION).toBeGreaterThan(0);
  });
});
