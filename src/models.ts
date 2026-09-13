/**
 * Model management for `local` review. GGUFs are NEVER bundled. Enabling local
 * review first SCANS the machine for models already present (llama.cpp, Ollama,
 * LM Studio, a configured dir, and our own store) and offers to reuse one; only
 * if none is found do we pull one from a small CURATED list of permissively
 * licensed models — showing size + source and requiring explicit consent (the
 * CLI gates that; this module just performs the download).
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig, paths, saveConfig } from './config.js';

export interface FoundModel {
  path: string;
  sizeBytes: number;
  source: 'llama.cpp' | 'ollama' | 'lmstudio' | 'configured' | 'palette';
}

export interface SuggestedModel {
  id: string;
  name: string;
  license: string;
  sizeBytes: number;
  url: string;
  note: string;
}

/** Curated, small, fast, permissively licensed instruct models (GGUF, Q4_K_M). */
export const SUGGESTED_MODELS: readonly SuggestedModel[] = [
  {
    id: 'qwen2.5-0.5b',
    name: 'Qwen2.5 0.5B Instruct',
    license: 'Apache-2.0',
    sizeBytes: 398_000_000,
    url: 'https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
    note: 'tiny + instant; good default for slot-tweak review',
  },
  {
    id: 'qwen2.5-1.5b',
    name: 'Qwen2.5 1.5B Instruct',
    license: 'Apache-2.0',
    sizeBytes: 1_120_000_000,
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    note: 'sharper judgment, still fast',
  },
  {
    id: 'smollm2-1.7b',
    name: 'SmolLM2 1.7B Instruct',
    license: 'Apache-2.0',
    sizeBytes: 1_060_000_000,
    url: 'https://huggingface.co/bartowski/SmolLM2-1.7B-Instruct-GGUF/resolve/main/SmolLM2-1.7B-Instruct-Q4_K_M.gguf',
    note: 'strong small-model reasoning',
  },
];

// --- scanning --------------------------------------------------------------

// A usable chat GGUF is at least this big; smaller .gguf are vocab/adapter stubs.
const MIN_MODEL_BYTES = 50_000_000;

/** Exclude vocab-only and multimodal-projector stubs — not standalone models. */
function isUsableGguf(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.gguf') && !n.includes('vocab') && !n.includes('mmproj');
}

function scanDir(dir: string, source: FoundModel['source'], depth = 3): FoundModel[] {
  if (!existsSync(dir)) return [];
  const out: FoundModel[] = [];
  const walk = (d: string, left: number): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && left > 0) walk(p, left - 1);
      else if (e.isFile() && isUsableGguf(e.name)) {
        try {
          const sizeBytes = statSync(p).size;
          if (sizeBytes >= MIN_MODEL_BYTES) out.push({ path: p, sizeBytes, source });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(dir, depth);
  return out;
}

/** Discover GGUFs already on the machine, de-duplicated by path. */
export function scanModels(): FoundModel[] {
  const home = homedir();
  const found: FoundModel[] = [
    ...scanDir(paths().models, 'palette'),
    ...scanDir(join(home, '.cache/llama.cpp'), 'llama.cpp'),
    ...scanDir(join(home, 'llama.cpp/models'), 'llama.cpp'),
    ...scanDir(join(home, '.ollama/models'), 'ollama'),
    ...scanDir(join(home, '.cache/lm-studio'), 'lmstudio'),
    ...scanDir(join(home, '.lmstudio'), 'lmstudio'),
  ];
  const configured = process.env.PALETTE_MODEL_DIR;
  if (configured) found.push(...scanDir(configured, 'configured'));
  const seen = new Set<string>();
  return found.filter((m) => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });
}

// --- pull ------------------------------------------------------------------

export function humanSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export function suggestedById(id: string): SuggestedModel | undefined {
  return SUGGESTED_MODELS.find((m) => m.id === id);
}

/**
 * Download a curated model into ~/.config/palette/models/. Consent (size/source
 * shown) is the CLI's responsibility; this performs the streamed download to a
 * temp file, then atomically renames into place. Returns the final path.
 */
export async function pullModel(
  id: string,
  onProgress?: (received: number, total: number) => void
): Promise<string> {
  const model = suggestedById(id);
  if (!model)
    throw new Error(
      `unknown model "${id}". See the Local review models screen in \`palette config\`.`
    );
  const dir = paths().models;
  const dest = join(dir, `${id}.gguf`);
  if (existsSync(dest)) return dest;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const res = await fetch(model.url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${model.url}`);
  const headerLength = Number(res.headers.get('content-length'));
  const total = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : model.sizeBytes;

  const tmp = `${dest}.part`;
  let received = 0;
  const source = Readable.fromWeb(res.body as import('stream/web').ReadableStream);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received, total);
  });
  try {
    await pipeline(source, createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true }); // never leave a half-written model behind
    throw err;
  }
  return dest;
}

// --- use -------------------------------------------------------------------

/**
 * Point local review at a model. Accepts an absolute path or a suggested id
 * (must already be pulled). Persists to config.modelPath.
 */
export function useModel(pathOrId: string): string {
  let modelPath = pathOrId;
  if (!pathOrId.includes('/')) {
    const candidate = join(paths().models, `${pathOrId}.gguf`);
    if (!existsSync(candidate))
      throw new Error(
        `"${pathOrId}" is not pulled. Pull it from \`palette config\` → Local review models first.`
      );
    modelPath = candidate;
  }
  if (!existsSync(modelPath)) throw new Error(`no such model file: ${modelPath}`);
  const cfg = loadConfig();
  cfg.modelPath = modelPath;
  cfg.defaults.reviewMode = 'local'; // selecting a model is what enables local review
  saveConfig(cfg);
  return modelPath;
}

export function currentModelPath(): string | undefined {
  return loadConfig().modelPath;
}
