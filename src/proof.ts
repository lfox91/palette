/**
 * Proof of Thought — citation of record for ideas with no prior art.
 *
 * When a contribution cannot be traced to existing literature, the operator's
 * exact prompt is recorded alongside the harness, model, date, and commit that
 * produced it, and the claim is hash-pinned. This is not a footnote: it is the
 * primary evidence of original reasoning. If the prompt changes, the hash
 * changes, and the claim of authorship is auditable.
 *
 * The integrity hash covers the claim itself (prompt, harness, model, date,
 * prior art) and deliberately NOT the `commit` field. A commit id is a mutable
 * locator: any history rewrite changes it without the claim changing at all.
 * Including it would make the hash unstable for reasons unrelated to authorship,
 * defeating the point of pinning. `commit` records where the idea landed; the
 * hash records what was claimed.
 *
 * Entries live in a ledger (`.tfw/docs/citations/proof-of-thought.json`, kept
 * out of the published tree) and render to markdown (`bun run proofs`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashText } from './hash.js';

export interface ProofOfThought {
  id: string;
  title: string;
  /** the operator's prompt, verbatim — typos and all */
  prompt: string;
  /** the agent harness that received it, e.g. "opencode" */
  harness: string;
  /** the model id that responded, e.g. "opencode-go/deepseek-v4.1-flash" */
  model: string;
  /** ISO 8601 date the prompt was made */
  date: string;
  /**
   * Commit the idea is realized in, or HEAD at capture. A mutable locator, not
   * part of the integrity hash — see the note at the top of this file.
   */
  commit: string;
  /** "none found" plus where it was searched, or a reference list */
  priorArt: string;
  /** path in-repo where the idea is realized */
  artifact?: string;
}

export interface ProofLedger {
  version: 1;
  entries: ProofOfThought[];
}

/**
 * Hash the claim, not its location. Covers prompt, harness, model, date, and
 * prior art; excludes `commit` so a history rewrite cannot invalidate a claim
 * whose wording never changed.
 */
export function proofHash(entry: ProofOfThought): string {
  return hashText(
    [entry.prompt, entry.harness, entry.model, entry.date, entry.priorArt].join('\n')
  );
}

export function defaultLedger(): ProofLedger {
  return { version: 1, entries: [] };
}

export function loadLedger(file: string): ProofLedger {
  if (!existsSync(file)) return defaultLedger();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProofLedger;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return defaultLedger();
    return parsed;
  } catch {
    return defaultLedger();
  }
}

export function saveLedger(file: string, ledger: ProofLedger): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

export function renderProof(entry: ProofOfThought): string {
  const lines = [
    `### ${entry.title}`,
    `- **Harness:** ${entry.harness}`,
    `- **Model:** ${entry.model}`,
    `- **Date:** ${entry.date}`,
    `- **Commit:** \`${entry.commit}\``,
    `- **Prior art:** ${entry.priorArt}`,
  ];
  if (entry.artifact) lines.push(`- **Realized in:** \`${entry.artifact}\``);
  lines.push(
    `- **Prompt (verbatim; sha256 \`${proofHash(entry).slice(0, 12)}\` for the full entry):**`,
    '',
    ...entry.prompt.split('\n').map((l) => `> ${l}`)
  );
  return lines.join('\n');
}

export function renderLedger(ledger: ProofLedger): string {
  if (ledger.entries.length === 0) return '# Proof of Thought\n\n_No entries recorded._\n';
  return [
    '# Proof of Thought',
    '',
    'Citations of record for contributions that have no prior art. Each entry is the',
    "operator's exact prompt, hash-pinned with the harness, model, date, and commit",
    'that produced it. A changed prompt produces a different hash.',
    '',
    ...ledger.entries.map(renderProof).flatMap((md) => [md, '']),
  ].join('\n');
}
