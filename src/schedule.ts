/**
 * Scheduler — regenerated per-period systemd USER timers, idempotent.
 *
 * systemd OnCalendar can't express "sunset + offset", so a static timer can't
 * self-adjust. But rewriting daily is needless churn: sunrise/sunset drift only
 * a few minutes a day, faster near the equinoxes. So `regen` recomputes each
 * period's fire time and writes a repeating daily `OnCalendar=*-*-* HH:MM:00`,
 * and only re-runs when the month's drift budget is spent (REGEN_INTERVAL_DAYS)
 * or a timer is missing. The scheduler timer itself re-invokes `regen` every 6h.
 *
 * Testability: PALETTE_UNIT_DIR redirects unit output; PALETTE_NO_SYSTEMCTL
 * skips the systemctl/daemon-reload side effects (unit files are still written).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLastRegen, writeLastRegen } from './config.js';
import { resolveTrigger } from './periods.js';
import type { Coordinates } from './solar.js';
import { resolveCoordinates } from './solar.js';
import type { Period, ScheduleConfig } from './types.js';

/**
 * Days between regens before sunrise/sunset drift likely exceeds ~10 min
 * (mid-latitudes; fastest at equinoxes, slowest at solstices). Keyed by month.
 */
export const REGEN_INTERVAL_DAYS: Record<number, number> = {
  1: 14,
  2: 8,
  3: 4,
  4: 5,
  5: 9,
  6: 20,
  7: 20,
  8: 9,
  9: 4,
  10: 5,
  11: 8,
  12: 14,
};

const PERIOD_SERVICE = 'palette-period@.service';
const SCHEDULER_SERVICE = 'palette-scheduler.service';
const SCHEDULER_TIMER = 'palette-scheduler.timer';

// --- environment ------------------------------------------------------------

export function unitDir(): string {
  return (
    process.env.PALETTE_UNIT_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user')
  );
}

function noSystemctl(): boolean {
  return process.env.PALETTE_NO_SYSTEMCTL === '1';
}

/** Absolute path to the palette executable, for embedding in ExecStart. */
export function resolveBin(): string {
  if (process.env.PALETTE_BIN) return process.env.PALETTE_BIN;
  try {
    const p = execFileSync('sh', ['-c', 'command -v palette'], { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch {
    /* fall through */
  }
  return process.execPath; // compiled single-file binary
}

export function systemdEscape(name: string): string {
  return execFileSync('systemd-escape', [name], { encoding: 'utf8' }).trim();
}

// --- unit text --------------------------------------------------------------

export function periodServiceUnit(bin: string): string {
  return `[Unit]
Description=Apply the palette for period %I

[Service]
Type=oneshot
ExecStart=${bin} apply-period "%I"
`;
}

export function schedulerServiceUnit(bin: string): string {
  return `[Unit]
Description=Regenerate palette period timers as the sun drifts

[Service]
Type=oneshot
ExecStart=${bin} regen
`;
}

export function schedulerTimerUnit(): string {
  return `[Unit]
Description=Periodic palette timer regeneration

[Timer]
OnBootSec=1min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
`;
}

export function periodTimerUnit(name: string, hhmm: string): string {
  return `[Unit]
Description=Palette period ${name} at ${hhmm}

[Timer]
OnCalendar=*-*-* ${hhmm}:00
Persistent=true

[Install]
WantedBy=timers.target
`;
}

// --- helpers ----------------------------------------------------------------

function daemonReload(): void {
  if (noSystemctl()) return;
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
}

function systemctl(args: string[]): void {
  if (noSystemctl()) return;
  execFileSync('systemctl', ['--user', ...args], { stdio: 'ignore' });
}

/** The fire time for a period today as local "HH:MM". Null on polar solar days. */
export function clockForPeriod(period: Period, coords: Coordinates, now: Date): string | null {
  const dt = resolveTrigger(period.trigger, now, coords);
  if (!dt) return null;
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

function periodTimerFile(name: string): string {
  return `palette-period@${systemdEscape(name)}.timer`;
}

function ensureUnitDir(): string {
  const dir = unitDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// --- install ----------------------------------------------------------------

/** Write the static units and enable the scheduler timer (part of `palette install`). */
export function installUnits(bin = resolveBin()): void {
  const dir = ensureUnitDir();
  writeFileSync(join(dir, PERIOD_SERVICE), periodServiceUnit(bin), 'utf8');
  writeFileSync(join(dir, SCHEDULER_SERVICE), schedulerServiceUnit(bin), 'utf8');
  writeFileSync(join(dir, SCHEDULER_TIMER), schedulerTimerUnit(), 'utf8');
  daemonReload();
  systemctl(['enable', '--now', SCHEDULER_TIMER]);
}

/** Remove all palette units and timers (part of `palette uninstall`). */
export function uninstallUnits(): void {
  const dir = unitDir();
  if (!existsSync(dir)) return;
  const timers = readdirSync(dir).filter(
    (f) => f.startsWith('palette-period@') && f.endsWith('.timer')
  );
  for (const t of timers) {
    systemctl(['disable', '--now', t]);
    rmSync(join(dir, t), { force: true });
  }
  systemctl(['disable', '--now', SCHEDULER_TIMER]);
  for (const f of [PERIOD_SERVICE, SCHEDULER_SERVICE, SCHEDULER_TIMER]) {
    rmSync(join(dir, f), { force: true });
  }
  daemonReload();
}

// --- regen ------------------------------------------------------------------

export interface RegenResult {
  regenerated: boolean;
  reason: string;
  timers: Array<{ period: string; at: string }>;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Idempotent timer regeneration. Writes/refreshes one repeating daily timer per
 * enabled period; a no-op when within the month's drift budget and all timers
 * already exist (unless `force`). Prunes timers for disabled/removed periods.
 */
export function regen(
  schedule: ScheduleConfig,
  opts: { force?: boolean; now?: Date; coords?: Coordinates | null } = {}
): RegenResult {
  const now = opts.now ?? new Date();
  const enabled = schedule.periods.filter((p) => p.enabled);
  const dir = ensureUnitDir();

  const timersExist = enabled.every((p) => existsSync(join(dir, periodTimerFile(p.name))));
  const last = readLastRegen();
  const interval = REGEN_INTERVAL_DAYS[now.getMonth() + 1] ?? 7;
  const drifted = !last || daysBetween(last, now) >= interval;

  if (!opts.force && !drifted && timersExist) {
    return { regenerated: false, reason: 'within drift budget; all timers present', timers: [] };
  }

  const coords = opts.coords ?? resolveCoordinates();
  if (!coords) {
    throw new Error(
      'no usable location (GNOME Night Light / GeoClue / timezone). Cannot compute solar times.'
    );
  }

  // prune timers for periods that are no longer enabled/present
  const wantFiles = new Set(enabled.map((p) => periodTimerFile(p.name)));
  for (const f of readdirSync(dir).filter(
    (x) => x.startsWith('palette-period@') && x.endsWith('.timer')
  )) {
    if (!wantFiles.has(f)) {
      systemctl(['disable', '--now', f]);
      rmSync(join(dir, f), { force: true });
    }
  }

  // write/refresh each enabled period's timer
  const timers: Array<{ period: string; at: string }> = [];
  for (const p of enabled) {
    const at = clockForPeriod(p, coords, now);
    if (!at) continue; // polar solar day: skip
    writeFileSync(join(dir, periodTimerFile(p.name)), periodTimerUnit(p.name, at), 'utf8');
    timers.push({ period: p.name, at });
  }

  daemonReload();
  for (const p of enabled) {
    if (existsSync(join(dir, periodTimerFile(p.name)))) {
      systemctl(['enable', '--now', periodTimerFile(p.name)]);
    }
  }
  writeLastRegen(now);
  return {
    regenerated: true,
    reason: opts.force ? 'forced' : drifted ? 'drift budget exceeded' : 'timers missing',
    timers,
  };
}
