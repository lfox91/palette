import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-review-'));

import { describe, expect, test } from 'bun:test';
import { dayPalette } from '../src/config.js';
import { managedPalettePath, renderPaletteFile } from '../src/ptyxis.js';
import { applyTweak, applyTweaks, isValidSlot, parseSuggestion } from '../src/review/index.js';
import type { PaletteVersion } from '../src/types.js';

describe('parseSuggestion', () => {
  test('extracts JSON buried in prose', () => {
    const s = parseSuggestion(
      'sure:\n{"approved":false,"rationale":"x","tweaks":[{"scheme":"dark","slot":"color6","hex":"#2ec4b6","reason":"teal"}]}\ndone'
    );
    expect(s.tweaks).toHaveLength(1);
    expect(s.tweaks[0]!.slot).toBe('color6');
  });

  test('approves only when approved AND no tweaks', () => {
    expect(parseSuggestion('{"approved":true,"rationale":"ok","tweaks":[]}').approved).toBe(true);
    expect(
      parseSuggestion(
        '{"approved":true,"rationale":"ok","tweaks":[{"scheme":"dark","slot":"color1","hex":"#ff0000","reason":"r"}]}'
      ).approved
    ).toBe(false);
  });

  test('drops invalid tweaks and tolerates garbage', () => {
    const s = parseSuggestion(
      '{"approved":false,"tweaks":[{"scheme":"dark","slot":"color99","hex":"#fff","reason":""},{"scheme":"sideways","slot":"color1","hex":"#fff","reason":""}]}'
    );
    expect(s.tweaks).toHaveLength(0);
    expect(parseSuggestion('not json at all').tweaks).toHaveLength(0);
  });
});

describe('slot validation', () => {
  test('accepts the 19 slots, rejects others', () => {
    for (const ok of ['foreground', 'background', 'cursor', 'color0', 'color15']) {
      expect(isValidSlot(ok)).toBe(true);
    }
    for (const bad of ['color16', 'color-1', 'bg', '', 'foreground ']) {
      expect(isValidSlot(bad)).toBe(false);
    }
  });
});

describe('applyTweaks', () => {
  test('applies a safe tweak', () => {
    const base = dayPalette();
    const r = applyTweaks(base, [
      { scheme: 'dark', slot: 'color6', hex: '#2ec4b6', reason: 'teal' },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.palette.dark.colors[6]).toBe('#2ec4b6');
  });

  test('rejects a tweak that breaks fg/bg contrast', () => {
    const base = dayPalette();
    const r = applyTweaks(base, [
      { scheme: 'dark', slot: 'foreground', hex: base.dark.background, reason: 'zero contrast' },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.validation.ok).toBe(true);
  });

  test('applyTweak is pure (does not mutate the input)', () => {
    const base = dayPalette();
    const before = base.dark.foreground;
    applyTweak(base, { scheme: 'dark', slot: 'foreground', hex: '#ffffff', reason: '' });
    expect(base.dark.foreground).toBe(before);
  });
});

describe('ptyxis rendering', () => {
  test('renders a dual-scheme .palette file', () => {
    const version: PaletteVersion = {
      name: 'X',
      input: { energy: 'med', warmth: 'neutral', contrast: 'balanced' },
      palette: dayPalette(),
    };
    const text = renderPaletteFile(version);
    expect(text).toContain('[Palette]');
    expect(text).toContain('Name=Sundial');
    expect(text).toContain('[Light]');
    expect(text).toContain('[Dark]');
    expect(text).toContain('Color15=');
    expect(text.endsWith('\n')).toBe(true);
  });

  test('managed path uses the managed name', () => {
    const env = { install: 'native' as const, palettesDir: '/tmp/palettes', profileUuid: 'x' };
    expect(managedPalettePath(env)).toBe('/tmp/palettes/Sundial.palette');
  });
});
