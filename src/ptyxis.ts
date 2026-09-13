/**
 * Ptyxis integration — the physical layer. Detects flatpak vs native, finds the
 * palettes dir and default profile, renders a PaletteVersion into the single
 * managed `Sundial.palette` file, and selects it once. Per the plan we keep ONE
 * managed file whose bytes are rewritten per period, rather than littering the
 * picker with per-mood files.
 *
 * THE open question (verify live, Verification step 4): does Ptyxis hot-reload a
 * *selected* palette when its file changes? Unproven, so applyVersion defaults
 * to a force-reload (flip the profile's `palette` key off and back) which
 * guarantees the new colors take effect — a brief flicker is acceptable for a
 * scheduled change. Once hot-reload is confirmed, pass { force: false }.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PaletteVersion, Scheme } from './types.js';
import { MANAGED_PALETTE_NAME } from './types.js';

const APP_ID = 'app.devsuite.Ptyxis';

export type Install = 'flatpak' | 'native';

export interface PtyxisEnv {
  install: Install;
  palettesDir: string;
  profileUuid: string;
}

// --- detection -------------------------------------------------------------

function commandOk(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectInstall(): Install | null {
  if (commandOk('flatpak', ['info', APP_ID])) return 'flatpak';
  // native: require the settings schema to actually resolve. A leftover data
  // directory (e.g. from a previous flatpak or a prior native install) is not
  // sufficient — trusting it leads to an uncaught gsettings failure on machines
  // where Ptyxis is not actually installed natively.
  if (commandOk('gsettings', ['get', 'org.gnome.Ptyxis', 'default-profile-uuid'])) return 'native';
  if (commandOk('sh', ['-c', 'command -v ptyxis'])) return 'native';
  return null;
}

export function palettesDirFor(install: Install): string {
  return install === 'flatpak'
    ? join(homedir(), '.var/app', APP_ID, 'data', APP_ID, 'palettes')
    : join(homedir(), '.local/share', APP_ID, 'palettes');
}

// --- gsettings (sandbox-aware) ---------------------------------------------

function gsettings(install: Install, args: string[]): string {
  const [cmd, cmdArgs] =
    install === 'flatpak'
      ? (['flatpak', ['run', '--command=gsettings', APP_ID, ...args]] as const)
      : (['gsettings', args] as const);
  return execFileSync(cmd, cmdArgs as string[], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function unquote(s: string): string {
  return s.trim().replace(/^'(.*)'$/, '$1');
}

export function defaultProfileUuid(install: Install): string {
  return unquote(gsettings(install, ['get', 'org.gnome.Ptyxis', 'default-profile-uuid']));
}

function profileSchemaPath(uuid: string): string {
  return `org.gnome.Ptyxis.Profile:/org/gnome/Ptyxis/Profiles/${uuid}/`;
}

export function getSelectedPalette(env: PtyxisEnv): string {
  return unquote(gsettings(env.install, ['get', profileSchemaPath(env.profileUuid), 'palette']));
}

export function setSelectedPalette(env: PtyxisEnv, name: string): void {
  gsettings(env.install, ['set', profileSchemaPath(env.profileUuid), 'palette', name]);
}

/** Resolve the full Ptyxis environment (throws if Ptyxis isn't installed). */
export function resolveEnv(): PtyxisEnv {
  const install = detectInstall();
  if (!install) {
    throw new Error(
      'Ptyxis does not appear to be installed (no flatpak app.devsuite.Ptyxis and no native install).'
    );
  }
  return {
    install,
    palettesDir: palettesDirFor(install),
    profileUuid: defaultProfileUuid(install),
  };
}

// --- palette file rendering -------------------------------------------------

function renderScheme(s: Scheme): string {
  return [
    `Background=${s.background}`,
    `Foreground=${s.foreground}`,
    `Cursor=${s.cursor}`,
    ...s.colors.map((c, i) => `Color${i}=${c}`),
  ].join('\n');
}

/** Render a version as a dual-scheme Ptyxis `.palette` (GKeyFile/INI). */
export function renderPaletteFile(version: PaletteVersion): string {
  return `${[
    '[Palette]',
    `Name=${MANAGED_PALETTE_NAME}`,
    '',
    '[Light]',
    renderScheme(version.palette.light),
    '',
    '[Dark]',
    renderScheme(version.palette.dark),
  ].join('\n')}\n`;
}

export function managedPalettePath(env: PtyxisEnv): string {
  return join(env.palettesDir, `${MANAGED_PALETTE_NAME}.palette`);
}

/** Write the managed Sundial.palette file (creating the palettes dir if needed). */
export function writeManagedPalette(env: PtyxisEnv, version: PaletteVersion): string {
  if (!existsSync(env.palettesDir)) mkdirSync(env.palettesDir, { recursive: true });
  const path = managedPalettePath(env);
  writeFileSync(path, renderPaletteFile(version), 'utf8');
  return path;
}

// --- apply ------------------------------------------------------------------

export interface ApplyOptions {
  /**
   * Force Ptyxis to re-read the file by flipping the profile's `palette` key
   * off and back on. Defaults true because file-change hot-reload is unverified
   * (THE open question). Set false once hot-reload is confirmed to avoid the
   * brief flicker.
   */
  force?: boolean;
}

/**
 * Write a version into the managed file and make it the active palette.
 * If it isn't selected yet, select it. If `force`, re-trigger a read.
 */
export function applyVersion(
  env: PtyxisEnv,
  version: PaletteVersion,
  opts: ApplyOptions = {}
): void {
  const force = opts.force ?? true;
  writeManagedPalette(env, version);

  const current = safe(() => getSelectedPalette(env));
  if (current !== MANAGED_PALETTE_NAME) {
    setSelectedPalette(env, MANAGED_PALETTE_NAME);
    return; // selecting it is itself a fresh read
  }
  if (force) {
    // flip off and back to force a re-read of the changed file
    setSelectedPalette(env, '');
    setSelectedPalette(env, MANAGED_PALETTE_NAME);
  }
}

/** One-time install step: write the managed file and select it. */
export function installManaged(env: PtyxisEnv, version: PaletteVersion): void {
  writeManagedPalette(env, version);
  setSelectedPalette(env, MANAGED_PALETTE_NAME);
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
