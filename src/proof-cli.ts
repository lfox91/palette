/**
 * Render the Proof of Thought ledger to markdown. Run with `bun run proofs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { ProofLedger } from './proof.js';
import { renderLedger } from './proof.js';

const ledgerUrl = new URL('../docs/citations/proof-of-thought.json', import.meta.url);
const outUrl = new URL('../docs/citations/proof-of-thought.md', import.meta.url);

const ledger = JSON.parse(readFileSync(ledgerUrl, 'utf8')) as ProofLedger;
writeFileSync(outUrl, renderLedger(ledger), 'utf8');
console.log(
  `Rendered ${ledger.entries.length} proof-of-thought entr${
    ledger.entries.length === 1 ? 'y' : 'ies'
  } to docs/citations/proof-of-thought.md`
);
