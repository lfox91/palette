import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-resilience-'));

import { describe, expect, test } from 'bun:test';
import { ensureInitialized, loadSchedule, paths } from '../src/config.js';

describe('corrupt config resilience', () => {
  test('a malformed schedule is quarantined, not silently discarded', () => {
    ensureInitialized();
    const good = readFileSync(paths().schedule, 'utf8');
    writeFileSync(paths().schedule, '{ this is not json', 'utf8');

    const sched = loadSchedule();
    expect(sched.periods.length).toBeGreaterThan(0); // falls back to defaults
    expect(existsSync(paths().schedule)).toBe(false); // moved aside

    const quarantined = readdirSync(paths().base).filter((f) =>
      f.startsWith('schedule.json.corrupt-')
    );
    expect(quarantined).toHaveLength(1);
    expect(good.length).toBeGreaterThan(0);
  });
});
