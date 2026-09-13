import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-sched-'));
process.env.PALETTE_UNIT_DIR = mkdtempSync(join(tmpdir(), 'palette-sched-units-'));
process.env.PALETTE_NO_SYSTEMCTL = '1';
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, test } from 'bun:test';
import { defaultSchedule } from '../src/config.js';
import { clockForPeriod, regen, resolveBin, systemdEscape } from '../src/schedule.js';
import type { Coordinates } from '../src/solar.js';

const LA: Coordinates = { lat: 34.0522, lon: -118.2437 };
const DAY = new Date(2026, 6, 3, 12, 0, 0);
const dir = process.env.PALETTE_UNIT_DIR!;

const timerFor = (name: string): string => join(dir, `palette-period@${systemdEscape(name)}.timer`);

describe('clockForPeriod', () => {
  test('formats HH:MM', () => {
    const morning = {
      name: 'morning',
      trigger: { kind: 'clock' as const, time: '06:00' },
      builtin: true,
      enabled: true,
    };
    expect(clockForPeriod(morning, LA, DAY)).toBe('06:00');
  });
});

describe('regen', () => {
  test('writes one timer per enabled period and is idempotent', () => {
    const sched = defaultSchedule();
    const first = regen(sched, { now: DAY, coords: LA, force: true });
    expect(first.regenerated).toBe(true);
    expect(first.timers.length).toBe(sched.periods.filter((p) => p.enabled).length);

    const second = regen(sched, { now: DAY, coords: LA });
    expect(second.regenerated).toBe(false);
    expect(second.timers).toHaveLength(0);
  });

  test('prunes the timer for a disabled period', () => {
    const sched = defaultSchedule();
    regen(sched, { now: DAY, coords: LA, force: true });
    expect(existsSync(timerFor('owl'))).toBe(true);

    sched.periods = sched.periods.map((p) => (p.name === 'owl' ? { ...p, enabled: false } : p));
    const r = regen(sched, { now: DAY, coords: LA, force: true });
    expect(r.timers.some((t) => t.period === 'owl')).toBe(false);
    expect(existsSync(timerFor('owl'))).toBe(false);
  });

  test('uses a supplied coordinate instead of probing the host', () => {
    const sched = defaultSchedule();
    const r = regen(sched, { now: DAY, coords: { lat: 0, lon: 0 }, force: true });
    expect(r.regenerated).toBe(true);
    expect(r.timers.length).toBeGreaterThan(0);
  });
});

describe('resolveBin', () => {
  test('honors PALETTE_BIN override', () => {
    const prev = process.env.PALETTE_BIN;
    process.env.PALETTE_BIN = '/usr/local/bin/palette';
    try {
      expect(resolveBin()).toBe('/usr/local/bin/palette');
    } finally {
      if (prev === undefined) delete process.env.PALETTE_BIN;
      else process.env.PALETTE_BIN = prev;
    }
  });

  test('resolves to a target systemd can actually execute', () => {
    const prev = process.env.PALETTE_BIN;
    delete process.env.PALETTE_BIN;
    try {
      const bin = resolveBin();
      expect(bin.length).toBeGreaterThan(0);
      const executable = bin.split(' ')[0]!;
      expect(existsSync(executable)).toBe(true);
    } finally {
      if (prev !== undefined) process.env.PALETTE_BIN = prev;
    }
  });
});
