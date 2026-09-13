import { describe, expect, test } from 'bun:test';
import { type ProofOfThought, proofHash, renderLedger, renderProof } from '../src/proof.js';

const entry: ProofOfThought = {
  id: 'x',
  title: 'Original idea',
  prompt: 'exact words here',
  harness: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  date: '2026-09-12',
  commit: 'abc123',
  priorArt: 'none found',
};

describe('proof of thought', () => {
  test('hash is stable and sensitive to the prompt', () => {
    const h = proofHash(entry);
    expect(h).toHaveLength(64);
    expect(proofHash({ ...entry })).toBe(h);
    expect(proofHash({ ...entry, prompt: 'different' })).not.toBe(h);
  });

  test('renders metadata and the verbatim prompt', () => {
    const md = renderProof(entry);
    expect(md).toContain('**Harness:** opencode');
    expect(md).toContain('**Commit:** `abc123`');
    expect(md).toContain('> exact words here');
    expect(md).toContain(proofHash(entry).slice(0, 12));
  });

  test('renders a ledger with every entry', () => {
    const md = renderLedger({
      version: 1,
      entries: [entry, { ...entry, id: 'y', title: 'Second' }],
    });
    expect(md).toContain('Original idea');
    expect(md).toContain('Second');
  });
});
