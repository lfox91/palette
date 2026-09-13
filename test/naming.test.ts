import { describe, expect, test } from 'bun:test';
import { nextFreeName } from '../src/config.js';

describe('nextFreeName', () => {
  test('returns the base when free, else the first free suffix', () => {
    expect(nextFreeName('x', () => false)).toBe('x');
    expect(nextFreeName('x', (n) => n === 'x')).toBe('x-2');
    expect(nextFreeName('x', (n) => n === 'x' || n === 'x-2')).toBe('x-3');
  });
});
