/**
 * Content hashing — the one primitive behind plugin pinning, prompt/goal
 * versioning, and candidate provenance. Kept dependency-free so any module can
 * use it without pulling in a subsystem.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** SHA-256 of a UTF-8 string, hex. */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** SHA-256 of a file's bytes, hex. */
export function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
