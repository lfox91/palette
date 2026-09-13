import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-periods-'));
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, test } from 'bun:test';
import {
  describeTrigger,
  nextOccurrence,
  parseClock,
  parseDurationMin,
  parseTrigger,
  resolveTrigger,
} from '../src/periods.js';
import type { Coordinates } from '../src/solar.js';

const LA: Coordinates = { lat: 34.0522, lon: -118.2437 };
const DAY = new Date(2026, 6, 3, 12, 0, 0);

describe('trigger parsing', () => {
  test('clock forms', () => {
    expect(parseTrigger('7am')).toEqual({ kind: 'clock', time: '07:00' });
    expect(parseTrigger('7:30pm')).toEqual({ kind: 'clock', time: '19:30' });
    expect(parseTrigger('12am')).toEqual({ kind: 'clock', time: '00:00' });
    expect(parseTrigger('12pm')).toEqual({ kind: 'clock', time: '12:00' });
    expect(parseTrigger('13:30')).toEqual({ kind: 'clock', time: '13:30' });
    expect(parseTrigger('06:00')).toEqual({ kind: 'clock', time: '06:00' });
  });

  test('solar forms, aliases, and offsets', () => {
    expect(parseTrigger('sunset')).toEqual({ kind: 'solar', anchor: 'sunset', offsetMin: 0 });
    expect(parseTrigger('dusk')).toEqual({ kind: 'solar', anchor: 'sunset', offsetMin: 0 });
    expect(parseTrigger('midday')).toEqual({ kind: 'solar', anchor: 'noon', offsetMin: 0 });
    expect(parseTrigger('solar noon')).toEqual({ kind: 'solar', anchor: 'noon', offsetMin: 0 });
    expect(parseTrigger('sunrise-15')).toEqual({
      kind: 'solar',
      anchor: 'sunrise',
      offsetMin: -15,
    });
    expect(parseTrigger('1h after sunrise')).toEqual({
      kind: 'solar',
      anchor: 'sunrise',
      offsetMin: 60,
    });
    expect(parseTrigger('30m before sunset')).toEqual({
      kind: 'solar',
      anchor: 'sunset',
      offsetMin: -30,
    });
    expect(parseTrigger('noon + 90m')).toEqual({ kind: 'solar', anchor: 'noon', offsetMin: 90 });
  });

  test('rejects nonsense and out-of-range clocks', () => {
    for (const bad of ['whenever', '', '  ', '25:00', '7:5pm', '13:75', '30m after']) {
      expect(() => parseTrigger(bad)).toThrow();
    }
  });

  test('parseClock canonicalizes', () => {
    expect(parseClock('7am')).toBe('07:00');
    expect(parseClock('7:00am')).toBe('07:00');
    expect(parseClock('00:05')).toBe('00:05');
    expect(parseClock('nope')).toBeNull();
  });

  test('parseDurationMin handles units and bare minutes', () => {
    expect(parseDurationMin('90')).toBe(90);
    expect(parseDurationMin('1h')).toBe(60);
    expect(parseDurationMin('1.5h')).toBe(90);
    expect(parseDurationMin('1h30m')).toBe(90);
    expect(parseDurationMin('15m')).toBe(15);
    expect(parseDurationMin('soon')).toBeNull();
  });

  test('parseDurationMin consumes the longest unit', () => {
    expect(parseDurationMin('30min')).toBe(30);
    expect(parseDurationMin('5minutes')).toBe(5);
    expect(parseDurationMin('2hr')).toBe(120);
    expect(parseDurationMin('1h30min')).toBe(90);
  });

  test('describeTrigger round-trips', () => {
    expect(describeTrigger({ kind: 'clock', time: '06:00' })).toBe('06:00');
    expect(describeTrigger({ kind: 'solar', anchor: 'sunset', offsetMin: 0 })).toBe('sunset');
    expect(describeTrigger({ kind: 'solar', anchor: 'sunset', offsetMin: -108 })).toBe(
      '1h48m before sunset'
    );
    expect(describeTrigger({ kind: 'solar', anchor: 'noon', offsetMin: 90 })).toBe(
      '1h30m after noon'
    );
  });
});

describe('resolution', () => {
  test('clock triggers resolve on the given local day', () => {
    const dt = resolveTrigger({ kind: 'clock', time: '06:00' }, DAY, LA)!;
    expect(dt.getHours()).toBe(6);
    expect(dt.getDate()).toBe(DAY.getDate());
  });

  test('solar triggers stay on the same local day as clock triggers', () => {
    const clock = resolveTrigger({ kind: 'clock', time: '06:00' }, DAY, LA)!;
    const solar = resolveTrigger({ kind: 'solar', anchor: 'sunset', offsetMin: 0 }, DAY, LA)!;
    expect(clock.getDate()).toBe(solar.getDate());
  });

  test('nextOccurrence is strictly in the future (or tomorrow)', () => {
    const now = new Date(2026, 6, 3, 23, 30, 0);
    const next = nextOccurrence({ kind: 'clock', time: '06:00' }, now, LA)!;
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  test('nextOccurrence never returns a past time across a DST transition', () => {
    for (const local of ['2026-03-08T23:30:00', '2026-11-01T23:30:00']) {
      const now = new Date(local);
      const next = nextOccurrence({ kind: 'clock', time: '06:00' }, now, LA)!;
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
