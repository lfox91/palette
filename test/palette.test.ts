import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the timezone so solar/clock resolution is deterministic and matches the
// LA test coordinates (the tool always runs in the user's own TZ, which matches
// their location). Must be set before any Date is constructed.
process.env.TZ = 'America/Los_Angeles';

// isolate all config/unit writes to throwaway dirs before importing the modules
process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-cfg-'));
process.env.PALETTE_UNIT_DIR = mkdtempSync(join(tmpdir(), 'palette-units-'));
process.env.PALETTE_NO_SYSTEMCTL = '1';

import { describe, expect, test } from 'bun:test';
import { dayPalette, defaultSchedule, eveningPalette } from '../src/config.js';
import { describeTrigger, parseTrigger, resolveTrigger } from '../src/periods.js';
import { applyTweaks, parseSuggestion } from '../src/review/index.js';
import { clockForPeriod, regen } from '../src/schedule.js';
import type { Coordinates } from '../src/solar.js';
import { solarUtcHour, sunTimes } from '../src/solar.js';
import { validatePalette } from '../src/validate.js';

const LA: Coordinates = { lat: 34.0522, lon: -118.2437 };
const DAY = new Date(2026, 6, 3, 12, 0, 0); // 2026-07-03 local noon

describe('solar', () => {
  test('solarUtcHour matches the reference algorithm (LA, 2026-07-03)', () => {
    expect(solarUtcHour(DAY, LA.lat, LA.lon, true)).toBeCloseTo(12.766581, 4);
    expect(solarUtcHour(DAY, LA.lat, LA.lon, false)).toBeCloseTo(3.136577, 4);
  });
  test('sunTimes are ordered sunrise < noon < sunset', () => {
    const t = sunTimes(DAY, LA)!;
    expect(t.sunrise.getTime()).toBeLessThan(t.noon.getTime());
    expect(t.noon.getTime()).toBeLessThan(t.sunset.getTime());
  });
  test('polar day returns null', () => {
    // Svalbard in June: sun never sets
    expect(solarUtcHour(new Date(2026, 5, 21), 78.2, 15.6, false)).toBeNull();
  });
});

describe('periods', () => {
  test('parses clock and solar expressions', () => {
    expect(parseTrigger('7am')).toEqual({ kind: 'clock', time: '07:00' });
    expect(parseTrigger('13:30')).toEqual({ kind: 'clock', time: '13:30' });
    expect(parseTrigger('sunset')).toEqual({ kind: 'solar', anchor: 'sunset', offsetMin: 0 });
    expect(parseTrigger('30m before sunset')).toEqual({
      kind: 'solar',
      anchor: 'sunset',
      offsetMin: -30,
    });
    expect(parseTrigger('1h after sunrise')).toEqual({
      kind: 'solar',
      anchor: 'sunrise',
      offsetMin: 60,
    });
  });
  test('describeTrigger round-trips offsets', () => {
    expect(describeTrigger({ kind: 'solar', anchor: 'sunset', offsetMin: -108 })).toBe(
      '1h48m before sunset'
    );
  });
  test('rejects nonsense', () => {
    expect(() => parseTrigger('whenever')).toThrow();
  });
  test('clock and solar resolve to the same local day', () => {
    const clock = resolveTrigger({ kind: 'clock', time: '06:00' }, DAY, LA)!;
    const solar = resolveTrigger({ kind: 'solar', anchor: 'sunset', offsetMin: 0 }, DAY, LA)!;
    expect(clock.getDate()).toBe(solar.getDate());
  });
});

describe('validation + seeds', () => {
  test('Day and Evening pass (no fatals)', () => {
    expect(validatePalette(dayPalette()).ok).toBe(true);
    expect(validatePalette(eveningPalette()).ok).toBe(true);
  });
  test('a broken palette is fatal', () => {
    const bad = dayPalette();
    bad.dark.foreground = bad.dark.background; // zero contrast
    expect(validatePalette(bad).ok).toBe(false);
  });
});

describe('review', () => {
  test('parseSuggestion extracts JSON from prose', () => {
    const s = parseSuggestion(
      'ok:\n{"approved":false,"rationale":"x","tweaks":[{"scheme":"dark","slot":"color6","hex":"#2ec4b6","reason":"teal"}]}\ndone'
    );
    expect(s.tweaks).toHaveLength(1);
    expect(s.tweaks[0]!.slot).toBe('color6');
  });
  test('applyTweaks rejects a tweak that breaks contrast', () => {
    const r = applyTweaks(dayPalette(), [
      { scheme: 'dark', slot: 'foreground', hex: '#003340', reason: 'x' },
    ]);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.validation.ok).toBe(true);
  });
});

describe('schedule', () => {
  test('clockForPeriod formats HH:MM', () => {
    expect(
      clockForPeriod(
        {
          name: 'morning',
          trigger: { kind: 'clock', time: '06:00' },
          builtin: true,
          enabled: true,
        },
        LA,
        DAY
      )
    ).toBe('06:00');
  });
  test('regen writes a timer per enabled period and is idempotent', () => {
    const sched = defaultSchedule();
    const first = regen(sched, { now: DAY, coords: LA, force: true });
    expect(first.regenerated).toBe(true);
    expect(first.timers.length).toBe(sched.periods.filter((p) => p.enabled).length);
    const second = regen(sched, { now: DAY, coords: LA });
    expect(second.regenerated).toBe(false);
  });
});
