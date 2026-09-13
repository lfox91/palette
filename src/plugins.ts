/**
 * Plugin model + trust.
 *
 * Three kinds can be extended: reviewer (accept/reject/tweak), sink (deliver a
 * palette to a terminal/editor), and deriver (produce a palette from a mood).
 *
 * Trust is explicit, not implied. Tiers, strongest first:
 *
 *   official  — authored and maintained in THIS repo, shipped in-process, and
 *               listed in the maintainer's allowlist. The maintainer's posture is
 *               to trust only what they authored or explicitly admitted into
 *               their revision graph. These, and only these, are enabled by
 *               default.
 *   local     — authored by the operator on this machine. Opt-in.
 *   community — anything anyone else publishes. NEVER enabled by default, ALWAYS
 *               out-of-process, ALWAYS hash-pinned. "Use at your own risk, for
 *               open study" — it is for mutual benchmarking, not for production.
 *
 * A lock file (`palette.lock.json`) pins id + version + content hash for every
 * enabled plugin; the CLI refuses to run a plugin whose content changed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from './config.js';
import { hashFile, hashText } from './hash.js';

export type PluginKind = 'reviewer' | 'sink' | 'deriver';
export type TrustTier = 'official' | 'local' | 'community';

export interface PluginManifest {
  id: string;
  kind: PluginKind;
  name: string;
  version: string;
  tier: TrustTier;
  author?: string;
  description?: string;
  /** in-process ES module path, for official/local plugins */
  entry?: string;
  /** argv for a subprocess plugin, for community plugins */
  command?: string[];
}

export interface PluginLockEntry {
  id: string;
  version: string;
  hash: string;
  tier: TrustTier;
}

export interface PluginLock {
  version: 1;
  plugins: PluginLockEntry[];
}

export const TIER_NOTE: Record<TrustTier, string> = {
  official: 'authored and shipped in this repo — trusted by default',
  local: 'authored on this machine — opt-in',
  community: 'third-party — never enabled by default; use at your own risk, for open study',
};

export function lockPath(): string {
  return `${paths().base}/palette.lock.json`;
}

export function defaultLock(): PluginLock {
  return { version: 1, plugins: [] };
}

export function loadLock(): PluginLock {
  const file = lockPath();
  if (!existsSync(file)) return defaultLock();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PluginLock;
    if (parsed.version !== 1 || !Array.isArray(parsed.plugins)) return defaultLock();
    return parsed;
  } catch {
    return defaultLock();
  }
}

export function saveLock(lock: PluginLock): void {
  writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

/** Stable hash of a plugin's identity and, where it lives on disk, its bytes. */
export function pluginContentHash(manifest: PluginManifest): string {
  const target = manifest.entry ?? manifest.command?.[0];
  if (target && existsSync(target)) return hashFile(target);
  return hashText(
    JSON.stringify({ id: manifest.id, version: manifest.version, kind: manifest.kind })
  );
}

export interface PluginCheck {
  ok: boolean;
  reason?: string;
}

/** Verify a manifest is allowed to run: hash pinned and tier policy satisfied. */
export function verifyPlugin(
  manifest: PluginManifest,
  lock: PluginLock,
  hash: string
): PluginCheck {
  const pinned = lock.plugins.find((p) => p.id === manifest.id);
  if (!pinned) return { ok: false, reason: `"${manifest.id}" is not pinned in palette.lock.json` };
  if (pinned.hash !== hash)
    return {
      ok: false,
      reason: `"${manifest.id}" content changed since it was pinned (hash mismatch)`,
    };
  if (pinned.tier !== manifest.tier)
    return {
      ok: false,
      reason: `"${manifest.id}" tier changed (${pinned.tier} → ${manifest.tier})`,
    };
  if (manifest.tier === 'community' && !manifest.command)
    return {
      ok: false,
      reason: `community plugin "${manifest.id}" must be out-of-process (command)`,
    };
  return { ok: true };
}

/**
 * The subprocess plugin contract: one JSON request on stdin, one JSON response
 * on stdout. Community plugins always run here, never in the CLI's process.
 */
export function runPluginProcess(
  command: string[],
  request: unknown,
  timeoutMs = 30_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Lazy import keeps this module loadable in contexts that never spawn.
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`plugin timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`plugin exited ${code}: ${stderr.trim()}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`plugin returned invalid JSON: ${stdout.slice(0, 200)}`));
        }
      });
      child.stdin?.end(JSON.stringify(request));
    });
  });
}
