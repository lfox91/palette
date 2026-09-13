#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface Rule {
  name: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { name: 'private-key', re: new RegExp(`-----BEGIN [A-Z ]*PRIVATE ${'KEY'}-----`) },
  { name: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'url-credentials', re: /:\/\/[^/\s:@]+:[^/\s@]+@/ },
  {
    name: 'assigned-secret',
    re: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/i,
  },
];

// The scanner's own source holds these patterns; never flag itself.
const SELF = 'scripts/scan-secrets.ts';

function tracked(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function isText(file: string): boolean {
  try {
    return !readFileSync(file).includes(0);
  } catch {
    return false;
  }
}

function scanLine(line: string, where: string, hits: string[]): void {
  for (const { name, re } of RULES) {
    if (re.test(line)) {
      hits.push(`${name}  ${where}  ${line.trim().slice(0, 80)}`);
    }
  }
}

const hits: string[] = [];

for (const file of tracked()) {
  if (file === SELF || !isText(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    scanLine(lines[i] ?? '', `${file}:${i + 1}`, hits);
  }
}

// History still holds removed secrets. Walk every diff and skip our own file.
const log = execFileSync('git', ['log', '--all', '-p', '--format=@@@%h'], {
  encoding: 'utf8',
  maxBuffer: 1 << 28,
});
let current = '';
const histLines = log.split('\n');
for (let i = 0; i < histLines.length; i++) {
  const line = histLines[i] ?? '';
  const header = line.match(/^\+\+\+ b\/(.+)$/);
  if (header) {
    current = header[1] ?? '';
    continue;
  }
  if (current === SELF || line.startsWith('@@@')) continue;
  scanLine(line, `history ${current}:${i + 1}`, hits);
}

if (hits.length > 0) {
  console.error(`secret-scan: ${hits.length} potential secret(s) found:`);
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}

console.log(`secret-scan: clean (${tracked().length} tracked files + full history)`);
