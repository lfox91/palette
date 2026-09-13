/**
 * Local reviewer — node-llama-cpp + a small GGUF, fully offline. node-llama-cpp
 * is an OPTIONAL dependency and is NEVER bundled into the compiled binary; we
 * import it by a computed specifier so `bun build --compile` can't embed it, and
 * point it at a model resolved from config (`palette config` → Local review models).
 *
 * If the dependency or a model isn't available, we throw a clear, actionable
 * error — the CLI catches it and falls back to no review.
 */

import { existsSync } from 'node:fs';
import type { MoodInput, PaletteConfig, PaletteSuggestion, RawPalette } from '../types.js';
import { buildReviewPrompt, parseSuggestion, type ReviewBackend } from './index.js';

export function makeLocalReviewer(config: PaletteConfig): ReviewBackend {
  return {
    mode: 'local',
    async review(palette: RawPalette, input: MoodInput): Promise<PaletteSuggestion> {
      const modelPath = config.modelPath;
      if (!modelPath || !existsSync(modelPath)) {
        throw new Error(
          'local review needs a GGUF model. Open `palette config` → Local review models to scan for one or pull a small model.'
        );
      }

      // computed specifier keeps the compiler from bundling node-llama-cpp
      const specifier = 'node-llama-cpp';
      let mod: typeof import('node-llama-cpp');
      try {
        mod = (await import(specifier)) as typeof import('node-llama-cpp');
      } catch {
        throw new Error(
          'node-llama-cpp is not installed. Install via npm (`npm i -g @leafox/palette` pulls it as an optional dep), or enable local review to fetch the backend as loose files.'
        );
      }

      const llama = await mod.getLlama();
      const model = await llama.loadModel({ modelPath });
      const context = await model.createContext({ contextSize: 4096 });
      try {
        const session = new mod.LlamaChatSession({ contextSequence: context.getSequence() });
        const answer = await session.prompt(buildReviewPrompt(palette, input), {
          temperature: 0.2,
          maxTokens: 900,
        });
        return parseSuggestion(answer);
      } finally {
        await context.dispose?.();
        await model.dispose?.();
        await llama.dispose?.();
      }
    },
  };
}
