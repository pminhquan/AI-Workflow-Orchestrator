import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256,scopedPath} from '../core/util.mjs';
import {isSensitivePath,noKnownSecrets} from './contracts.mjs';
import {EXCLUDED_ROOTS,readBoundedBytes,MAX_WORKSPACE_BYTES,MAX_WORKSPACE_FILE_BYTES} from './verification.mjs';

const RACY_WRITE_WINDOW_MS = 50;
const MAX_SNAPSHOT_FILES = 2000;
const MAX_SNAPSHOT_BYTES = MAX_WORKSPACE_BYTES;

const workspaceCaches = new Map();
let hits = 0;
let misses = 0;

function normalizeWorkspaceKey(workspacePath) {
  return process.platform === 'win32' ? workspacePath.toLowerCase() : workspacePath;
}

export function invalidateWorkspaceCache(workspace = null) {
  if (workspace === null || workspace === undefined) {
    workspaceCaches.clear();
    return;
  }
  const candidates = new Set([normalizeWorkspaceKey(resolve(workspace))]);
  try {
    candidates.add(normalizeWorkspaceKey(realpathSync(workspace)));
  } catch {}
  for (const key of candidates) workspaceCaches.delete(key);
}

export function getSnapshotCacheStats() {
  let entries = 0;
  for (const cache of workspaceCaches.values()) entries += cache.size;
  return {
    workspaces: workspaceCaches.size,
    entries,
    hits,
    misses
  };
}

export function captureWorkspaceFast(workspace, { verifyHashes = false } = {}) {
  workspace = realpathSync(workspace);
  const cacheKey = normalizeWorkspaceKey(workspace);
  let fileCache = workspaceCaches.get(cacheKey);
  if (!fileCache) {
    fileCache = new Map();
    workspaceCaches.set(cacheKey, fileCache);
  }

  const entries = Object.create(null);
  const seen = new Set();
  let count = 0, bytes = 0;

  function visit(relativePath) {
    if (isSensitivePath(relativePath)) return;
    const path = scopedPath(workspace, relativePath);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(relativePath + '/' + child);
    } else {
      if (!stat.isFile() || ++count > MAX_SNAPSHOT_FILES || (bytes += stat.size) > MAX_SNAPSHOT_BYTES) {
        throw Error('Workspace snapshot limit/nonregular file');
      }
      seen.add(relativePath);
      const cached = fileCache.get(relativePath);
      if (
        !verifyHashes &&
        cached &&
        stat.size === cached.size &&
        stat.mtimeMs === cached.mtimeMs &&
        stat.ino === cached.ino &&
        stat.mtimeMs < Date.now() - RACY_WRITE_WINDOW_MS
      ) {
        hits++;
        entries[relativePath] = cached.hash;
      } else {
        misses++;
        const data = readBoundedBytes(path, Math.min(MAX_WORKSPACE_FILE_BYTES,MAX_SNAPSHOT_BYTES - (bytes - stat.size)));
        bytes += data.length - stat.size;
        const hash = sha256(data);
        fileCache.set(relativePath, {
          size: data.length,
          mtimeMs: stat.mtimeMs,
          ino: stat.ino,
          hash
        });
        entries[relativePath] = hash;
      }
    }
  }

  for (const name of readdirSync(workspace).sort()) {
    if (EXCLUDED_ROOTS.includes(name.toLowerCase())) continue;
    if (name === '.codex') {
      const configRoot = scopedPath(workspace, name);
      if (!lstatSync(configRoot).isDirectory()) throw Error('Project .codex must be a regular directory');
      const children = readdirSync(configRoot);
      // Ignore private Codex entries; only the already managed MCP config is hashed.
      if (children.includes('config.toml')) {
        const config = readBoundedBytes(scopedPath(workspace, '.codex/config.toml'), 32768);
        noKnownSecrets(config.toString('utf8'));
        entries['.codex/config.toml'] = sha256(config);
      }
      continue;
    }
    visit(name);
  }

  for (const cachedPath of fileCache.keys()) {
    if (!seen.has(cachedPath)) fileCache.delete(cachedPath);
  }

  return { entries, hash: sha256(entries) };
}
