import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-pluginrev-'));

import { describe, expect, test } from 'bun:test';
import { dayPalette } from '../src/config.js';
import { makePluginReviewer } from '../src/plugin-reviewer.js';
import { findPlugin, installPlugin, type PluginManifest, removePlugin } from '../src/plugins.js';
import type { PaletteConfig } from '../src/types.js';

const MOOD = { energy: 'med', warmth: 'neutral', contrast: 'balanced' } as const;

function config(pluginId: string): PaletteConfig {
  return {
    defaults: { reviewMode: 'plugin', mood: {}, pluginId, applyScope: 'until-next-change' },
  };
}

function writeManifest(dir: string, manifest: PluginManifest): string {
  const file = join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

describe('plugin lock management', () => {
  test('installing demotes a self-declared official to local and pins a hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'palette-install-'));
    const entry = join(dir, 'rev.mjs');
    writeFileSync(entry, 'export default () => ({ approved: true, rationale: "x", tweaks: [] });');
    const file = writeManifest(dir, {
      id: 'acme/official-claim',
      kind: 'reviewer',
      name: 'Claim',
      version: '1.0.0',
      tier: 'official',
      entry: 'rev.mjs',
    });
    const pinned = installPlugin(file);
    expect(pinned.tier).toBe('local');
    expect(pinned.manifest?.entry).toBe(entry);
    expect(pinned.hash).toHaveLength(64);
    expect(findPlugin('acme/official-claim')?.version).toBe('1.0.0');
    expect(removePlugin('acme/official-claim')).toBe(true);
    expect(findPlugin('acme/official-claim')).toBeNull();
  });

  test('a community plugin without a command is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'palette-install-bad-'));
    const file = writeManifest(dir, {
      id: 'acme/bad',
      kind: 'reviewer',
      name: 'Bad',
      version: '1.0.0',
      tier: 'community',
    });
    expect(() => installPlugin(file)).toThrow(/out-of-process/);
  });
});

describe('plugin reviewer backend', () => {
  test('runs a local plugin in-process and parses its suggestion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'palette-inproc-'));
    const entry = join(dir, 'rev.mjs');
    writeFileSync(
      entry,
      "export default (req) => ({ approved: true, rationale: 'saw ' + req.palette.dark.colors.length + ' colors', tweaks: [] });"
    );
    const file = writeManifest(dir, {
      id: 'local/inproc',
      kind: 'reviewer',
      name: 'In-process',
      version: '1.0.0',
      tier: 'local',
      entry: 'rev.mjs',
    });
    installPlugin(file);
    const reviewer = await makePluginReviewer(config('local/inproc'));
    expect(reviewer.mode).toBe('plugin');
    const suggestion = await reviewer.review(dayPalette(), MOOD);
    expect(suggestion.approved).toBe(true);
    expect(suggestion.rationale).toContain('16 colors');
    rmSync(dir, { recursive: true, force: true });
  });

  test('runs a community plugin out-of-process over stdin/stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'palette-subproc-'));
    const script = join(dir, 'rev.sh');
    writeFileSync(
      script,
      '#!/bin/sh\ncat > /dev/null\nprintf \'{"approved":true,"rationale":"proc ok","tweaks":[]}\'\n'
    );
    chmodSync(script, 0o755);
    const file = writeManifest(dir, {
      id: 'community/proc',
      kind: 'reviewer',
      name: 'Proc',
      version: '1.0.0',
      tier: 'community',
      command: [script],
    });
    installPlugin(file);
    const reviewer = await makePluginReviewer(config('community/proc'));
    const suggestion = await reviewer.review(dayPalette(), MOOD);
    expect(suggestion.rationale).toBe('proc ok');
    rmSync(dir, { recursive: true, force: true });
  });

  test('refuses an unpinned plugin', async () => {
    await expect(makePluginReviewer(config('missing/plugin'))).rejects.toThrow(/not pinned/);
  });
});
