import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-cfg-'));
process.env.PALETTE_UNIT_DIR = mkdtempSync(join(tmpdir(), 'palette-units-'));
process.env.PALETTE_NO_SYSTEMCTL = '1';
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, test } from 'bun:test';
import {
  dayPalette,
  defaultConfig,
  defaultSchedule,
  ensureInitialized,
  eveningPalette,
  loadConfig,
  loadSchedule,
  paths,
  saveConfig,
  saveSchedule,
} from '../src/config.js';
import { validatePalette } from '../src/validate.js';

describe('seeded palettes', () => {
  test('Day and Evening both pass the full gate', () => {
    expect(validatePalette(dayPalette()).clean).toBe(true);
    expect(validatePalette(eveningPalette()).clean).toBe(true);
  });

  test('Evening is derived from Day (warmer/dimmer, still complete)', () => {
    const day = dayPalette();
    const eve = eveningPalette();
    expect(eve.light.colors).toHaveLength(16);
    expect(eve.dark.colors).toHaveLength(16);
    expect(eve.dark.background).not.toBe(day.dark.background);
  });
});

describe('default schedule', () => {
  test('every enabled assignment points at a real version', () => {
    const s = defaultSchedule();
    expect(s.periods).toHaveLength(5);
    expect(Object.keys(s.versions).sort()).toEqual(['Day', 'Evening']);
    for (const per of s.periods) {
      expect(s.versions[s.assignments[per.name]!]).toBeDefined();
    }
  });

  test('built-ins are flagged so they can be disabled but not deleted', () => {
    const s = defaultSchedule();
    expect(s.periods).toHaveLength(5);
    expect(s.periods.every((p) => p.builtin)).toBe(true);
    const custom = {
      name: 'gym',
      trigger: { kind: 'clock' as const, time: '06:30' },
      builtin: false,
      enabled: true,
    };
    const all = [...s.periods, custom];
    expect(all.filter((p) => p.builtin).map((p) => p.name)).not.toContain('gym');
  });
});

describe('persistence', () => {
  test('paths honor PALETTE_CONFIG_DIR', () => {
    expect(paths().base).toBe(process.env.PALETTE_CONFIG_DIR!);
    expect(paths().schedule.endsWith('schedule.json')).toBe(true);
  });

  test('ensureInitialized seeds config + schedule once', () => {
    const p = ensureInitialized();
    const seeded = loadSchedule();
    expect(seeded.periods).toHaveLength(5);
    // idempotent: a second call must not overwrite an existing schedule
    seeded.assignments.morning = 'Evening';
    saveSchedule(seeded);
    ensureInitialized();
    expect(loadSchedule().assignments.morning).toBe('Evening');
    expect(p.config).toBe(paths().config);
  });

  test('config round-trips through disk', () => {
    const c = defaultConfig();
    c.defaults.reviewMode = 'local';
    c.defaults.applyScope = 'all-times';
    saveConfig(c);
    const back = loadConfig();
    expect(back.defaults.reviewMode).toBe('local');
    expect(back.defaults.applyScope).toBe('all-times');
  });
});
