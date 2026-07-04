/**
 * Remote reviewer — bring-your-own API key. The ONLY backend that touches the
 * network, and only when the user has explicitly chosen `remote` and set a key.
 * The key is read from an environment variable named in config (never stored in
 * config, never sent anywhere but the chosen provider).
 *
 * Supports Anthropic's Messages API and any OpenAI-compatible chat endpoint.
 */

import type { MoodInput, PaletteConfig, PaletteSuggestion, RawPalette } from '../types.js';
import { buildReviewPrompt, parseSuggestion, type ReviewBackend } from './index.js';

const DEFAULT_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001', // fast + cheap; review is a small judgment task
  'openai-compatible': 'gpt-4o-mini',
};

export function makeRemoteReviewer(config: PaletteConfig): ReviewBackend {
  return {
    mode: 'remote',
    async review(palette: RawPalette, input: MoodInput): Promise<PaletteSuggestion> {
      const remote = config.remote;
      if (!remote) {
        throw new Error(
          'remote review is not configured. Run `palette configure` to set a provider and API-key env var.'
        );
      }
      const envName = remote.apiKeyEnv ?? DEFAULT_ENV[remote.provider];
      const apiKey = envName ? process.env[envName] : undefined;
      if (!apiKey) {
        throw new Error(
          `remote review key not found. Set ${envName ?? '<API key env var>'} in your environment.`
        );
      }
      const prompt = buildReviewPrompt(palette, input);
      const model = remote.model ?? DEFAULT_MODEL[remote.provider] ?? 'gpt-4o-mini';
      const text =
        remote.provider === 'anthropic'
          ? await callAnthropic(apiKey, model, prompt)
          : await callOpenAiCompatible(
              apiKey,
              remote.baseUrl ?? 'https://api.openai.com/v1',
              model,
              prompt
            );
      return parseSuggestion(text);
    },
  };
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return data.content?.map((c) => c.text ?? '').join('') ?? '';
}

async function callOpenAiCompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}
