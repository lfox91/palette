/**
 * Render the Proof of Thought ledger to markdown. Run with `bun run proofs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { ProofLedger } from './proof.js';
import { renderLedger } from './proof.js';

// The ledger lives under the local, gitignored .tfw tree rather than in the
// published source, so the proofs script resolves it relative to the repo root.
const dir = new URL('../.tfw/docs/citations/', import.meta.url);
const ledgerUrl = new URL('proof-of-thought.json', dir);
const outUrl = new URL('proof-of-thought.md', dir);

const ledger = JSON.parse(readFileSync(ledgerUrl, 'utf8')) as ProofLedger;
writeFileSync(outUrl, renderLedger(ledger), 'utf8');
console.log(
  `Rendered ${ledger.entries.length} proof-of-thought entr${
    ledger.entries.length === 1 ? 'y' : 'ies'
  } to .tfw/docs/citations/proof-of-thought.md`
);
