/**
 * Reviewer backend backed by a pinned plugin (see src/plugins.ts).
 *
 * Trust tiers decide the execution model, not the operator's convenience:
 * official/local plugins run in-process via a dynamic import; community plugins
 * ALWAYS run out-of-process through runPluginProcess. Either way the plugin is
 * hash-verified against palette.lock.json before it runs, and its response is
 * parsed through the same parser as every other backend — so a plugin cannot
 * originate a color or bypass validatePalette.
 */

import { pathToFileURL } from 'node:url';
import {
  findPlugin,
  loadLock,
  pluginContentHash,
  runPluginProcess,
  verifyPlugin,
} from './plugins.js';
import { buildReviewPrompt, parseSuggestion, type ReviewBackend } from './review/index.js';
import type { MoodInput, PaletteConfig, PaletteSuggestion, RawPalette } from './types.js';

/** The plugin contract: one JSON-friendly request, one suggestion back. */
export interface PluginReviewRequest {
  kind: 'review';
  prompt: string;
  palette: RawPalette;
  mood: MoodInput;
}

interface InProcessModule {
  default?: (request: PluginReviewRequest) => unknown;
  review?: (request: PluginReviewRequest) => unknown;
}

async function runInProcess(
  pluginId: string,
  entry: string,
  request: PluginReviewRequest
): Promise<unknown> {
  const mod = (await import(pathToFileURL(entry).href)) as InProcessModule;
  const fn = mod.default ?? mod.review;
  if (typeof fn !== 'function') {
    throw new Error(`plugin "${pluginId}" exports no review function`);
  }
  return await fn(request);
}

export async function makePluginReviewer(config: PaletteConfig): Promise<ReviewBackend> {
  const id = config.defaults.pluginId;
  if (!id) {
    throw new Error(
      'review mode is "plugin" but no plugin is selected — choose one in `palette config`'
    );
  }
  const pinned = findPlugin(id);
  if (!pinned?.manifest) {
    throw new Error(`plugin "${id}" is not pinned in palette.lock.json`);
  }
  const manifest = pinned.manifest;
  const check = verifyPlugin(manifest, loadLock(), pluginContentHash(manifest));
  if (!check.ok) throw new Error(check.reason ?? `plugin "${id}" failed verification`);
  if (manifest.kind !== 'reviewer') {
    throw new Error(`plugin "${id}" is a ${manifest.kind}, not a reviewer`);
  }

  const isCommunity = manifest.tier === 'community';
  if (isCommunity && !manifest.command) {
    throw new Error(`community plugin "${id}" must declare a command`);
  }
  if (!isCommunity && !manifest.entry) {
    throw new Error(`${manifest.tier} plugin "${id}" must declare an in-process entry`);
  }

  return {
    mode: 'plugin',
    async review(palette: RawPalette, mood: MoodInput): Promise<PaletteSuggestion> {
      const request: PluginReviewRequest = {
        kind: 'review',
        prompt: buildReviewPrompt(palette, mood),
        palette,
        mood,
      };
      const raw = isCommunity
        ? await runPluginProcess(manifest.command!, request)
        : await runInProcess(id, manifest.entry!, request);
      return parseSuggestion(typeof raw === 'string' ? raw : JSON.stringify(raw));
    },
  };
}
