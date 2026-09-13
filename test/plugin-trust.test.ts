import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-trust-'));

import { describe, expect, test } from 'bun:test';
import { runBench } from '../src/bench.js';
import { dayPalette } from '../src/config.js';
import { makePluginReviewer } from '../src/plugin-reviewer.js';
import { installPlugin, type PluginManifest } from '../src/plugins.js';
import { applyTweaks, getReviewer, type ReviewBackend } from '../src/review/index.js';
import type { PaletteConfig } from '../src/types.js';

const MOOD = { energy: 'med', warmth: 'neutral', contrast: 'balanced' } as const;

function config(pluginId: string): PaletteConfig {
  return {
    defaults: { reviewMode: 'plugin', mood: {}, pluginId, applyScope: 'until-next-change' },
  };
}

let counter = 0;
function makeDir(): string {
  return mkdtempSync(join(tmpdir(), `palette-trust-${counter++}-`));
}

function writeManifest(dir: string, manifest: PluginManifest): string {
  const file = join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function reviewerModule(body: string): string {
  return `export default () => (${body});`;
}

describe('plugin trust boundary (intent)', () => {
  test('a plugin edited after pinning is refused at execution time', async () => {
    const dir = makeDir();
    const entry = join(dir, 'rev.mjs');
    writeFileSync(entry, reviewerModule(`{ approved: true, rationale: 'v1', tweaks: [] }`));
    const file = writeManifest(dir, {
      id: 'local/mutable',
      kind: 'reviewer',
      name: 'Mutable',
      version: '1.0.0',
      tier: 'local',
      entry: 'rev.mjs',
    });
    installPlugin(file);

    // Tamper with the code after the hash was pinned.
    writeFileSync(entry, reviewerModule(`{ approved: true, rationale: 'v2', tweaks: [] }`));

    await expect(makePluginReviewer(config('local/mutable'))).rejects.toThrow(/content changed/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('community tier runs out-of-process even when an entry is present', async () => {
    const dir = makeDir();
    const entry = join(dir, 'rev.mjs');
    writeFileSync(entry, reviewerModule(`{ approved: true, rationale: 'in process', tweaks: [] }`));
    const script = join(dir, 'rev.sh');
    writeFileSync(
      script,
      '#!/bin/sh\ncat > /dev/null\nprintf \'{"approved":true,"rationale":"out of process","tweaks":[]}\'\n'
    );
    chmodSync(script, 0o755);
    const file = writeManifest(dir, {
      id: 'community/oop',
      kind: 'reviewer',
      name: 'OOP',
      version: '1.0.0',
      tier: 'community',
      entry: 'rev.mjs',
      command: [script],
    });
    installPlugin(file);

    const reviewer = await makePluginReviewer(config('community/oop'));
    const suggestion = await reviewer.review(dayPalette(), MOOD);
    expect(suggestion.rationale).toBe('out of process');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a plugin cannot bypass the safety gate, however it responds', async () => {
    const dir = makeDir();
    const entry = join(dir, 'rev.mjs');
    const background = dayPalette().dark.background;
    writeFileSync(
      entry,
      reviewerModule(
        `{ approved: false, rationale: 'make foreground the background', tweaks: [{ scheme: 'dark', slot: 'foreground', hex: '${background}', reason: 'intentional collision' }] }`
      )
    );
    const file = writeManifest(dir, {
      id: 'local/unsafe',
      kind: 'reviewer',
      name: 'Unsafe',
      version: '1.0.0',
      tier: 'local',
      entry: 'rev.mjs',
    });
    installPlugin(file);

    const reviewer = await makePluginReviewer(config('local/unsafe'));
    const suggestion = await reviewer.review(dayPalette(), MOOD);
    const result = applyTweaks(dayPalette(), suggestion.tweaks);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the configured review mode routes to the plugin backend', async () => {
    const dir = makeDir();
    const entry = join(dir, 'rev.mjs');
    writeFileSync(entry, reviewerModule(`{ approved: true, rationale: 'routed', tweaks: [] }`));
    const file = writeManifest(dir, {
      id: 'local/routed',
      kind: 'reviewer',
      name: 'Routed',
      version: '1.0.0',
      tier: 'local',
      entry: 'rev.mjs',
    });
    installPlugin(file);

    const reviewer = await getReviewer(config('local/routed'));
    expect(reviewer.mode).toBe('plugin');
    const suggestion = await reviewer.review(dayPalette(), MOOD);
    expect(suggestion.rationale).toBe('routed');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('benchmark measures the reviewer (intent)', () => {
  test('an always-rejecting reviewer drives approval down and tweaks up', async () => {
    const rejecting: ReviewBackend = {
      mode: 'plugin',
      async review() {
        return {
          approved: false,
          rationale: 'The hue reads slightly off the intended mood.',
          tweaks: [
            {
              scheme: 'dark',
              slot: 'color5',
              hex: '#cc44aa',
              reason: 'nudge magenta toward its role hue',
            },
          ],
        };
      },
    };
    const run = await runBench({
      label: 'rejecting',
      reviewer: rejecting,
      size: 3,
      runSeed: 'trust-rejecting',
    });
    expect(run.summary.cases).toBe(3);
    expect(run.summary.approvedRate).toBe(0);
    expect(run.summary.meanTweaks).toBeGreaterThan(0);
    expect(run.summary.scopeViolations).toBe(0);
  });

  test('a broken reviewer does not crash the run', async () => {
    const broken: ReviewBackend = {
      mode: 'none',
      async review() {
        throw new Error('reviewer exploded');
      },
    };
    const run = await runBench({
      label: 'broken',
      reviewer: broken,
      size: 2,
      runSeed: 'trust-broken',
    });
    expect(run.summary.cases).toBe(2);
  });
});
