import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PALETTE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'palette-plugins-'));

import { describe, expect, test } from 'bun:test';
import {
  defaultLock,
  loadLock,
  type PluginManifest,
  pluginContentHash,
  runPluginProcess,
  saveLock,
  verifyPlugin,
} from '../src/plugins.js';

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'acme/reviewer',
    kind: 'reviewer',
    name: 'Acme',
    version: '1.0.0',
    tier: 'community',
    command: ['true'],
    ...over,
  };
}

describe('plugin lock + trust', () => {
  test('lock round-trips and defaults when absent', () => {
    const l = loadLock();
    expect(l).toEqual(defaultLock());
    l.plugins.push({ id: 'x', version: '1', hash: 'h', tier: 'official' });
    saveLock(l);
    expect(loadLock().plugins).toHaveLength(1);
  });

  test('verify rejects unpinned, hash mismatch, tier change, in-process community', () => {
    const m = manifest();
    const lock = defaultLock();
    expect(verifyPlugin(m, lock, 'h').ok).toBe(false);

    lock.plugins.push({ id: m.id, version: m.version, hash: 'h1', tier: 'community' });
    expect(verifyPlugin(m, lock, 'h2').ok).toBe(false);
    expect(verifyPlugin(m, lock, 'h1').ok).toBe(true);
    expect(verifyPlugin(manifest({ tier: 'local' }), lock, 'h1').ok).toBe(false);
    expect(verifyPlugin(manifest({ command: undefined }), lock, 'h1').ok).toBe(false);
  });

  test('content hash follows the bytes on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'palette-hash-'));
    const f = join(dir, 'p.sh');
    writeFileSync(f, 'echo hi');
    const m = manifest({ command: [f] });
    const first = pluginContentHash(m);
    writeFileSync(f, 'echo bye');
    expect(pluginContentHash(m)).not.toBe(first);
  });
});

describe('runPluginProcess', () => {
  test('passes JSON in and parses JSON out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'palette-proc-'));
    const script = join(dir, 'p.sh');
    writeFileSync(script, '#!/bin/sh\ncat > /dev/null\nprintf \'{"ok":true}\'\n');
    chmodSync(script, 0o755);
    await expect(runPluginProcess([script], { hi: 1 })).resolves.toEqual({ ok: true });
  });

  test('rejects invalid JSON and non-zero exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'palette-proc2-'));
    const bad = join(dir, 'bad.sh');
    writeFileSync(bad, "#!/bin/sh\ncat > /dev/null\nprintf 'not json'\n");
    chmodSync(bad, 0o755);
    await expect(runPluginProcess([bad], {})).rejects.toThrow(/invalid JSON/);

    const fail = join(dir, 'fail.sh');
    writeFileSync(fail, '#!/bin/sh\ncat > /dev/null\nexit 3\n');
    chmodSync(fail, 0o755);
    await expect(runPluginProcess([fail], {})).rejects.toThrow(/exited 3/);
  });
});
