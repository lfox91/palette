import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-models-'));

import { describe, expect, test } from 'bun:test';
import { ensureInitialized, loadConfig, paths } from '../src/config.js';
import { humanSize, SUGGESTED_MODELS, suggestedById, useModel } from '../src/models.js';

describe('model catalogue', () => {
  test('humanSize formats KB / MB / GB', () => {
    expect(humanSize(5000)).toBe('5 KB');
    expect(humanSize(2_000_000)).toBe('2 MB');
    expect(humanSize(1_500_000_000)).toBe('1.5 GB');
  });

  test('suggestedById resolves known ids only', () => {
    expect(SUGGESTED_MODELS).toHaveLength(3);
    expect(suggestedById('qwen2.5-0.5b')?.license).toBe('Apache-2.0');
    expect(suggestedById('does-not-exist')).toBeUndefined();
  });
});

describe('useModel', () => {
  test('selecting a model persists the path and enables local review', () => {
    ensureInitialized();
    const modelFile = join(paths().models, 'fake.gguf');
    writeFileSync(modelFile, 'gguf');

    expect(useModel(modelFile)).toBe(modelFile);
    const cfg = loadConfig();
    expect(cfg.modelPath).toBe(modelFile);
    expect(cfg.defaults.reviewMode).toBe('local');
  });

  test('an unpublished id is rejected with guidance', () => {
    expect(() => useModel('qwen2.5-0.5b')).toThrow(/not pulled/);
  });
});
