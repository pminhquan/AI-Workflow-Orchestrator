import {lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256,scopedPath} from '../core/util.mjs';
import {canonicalWorkspace,noKnownSecrets} from './contracts.mjs';
import {workspaceFiles} from './workspace-files.mjs';
import {readBoundedBytes,MAX_WORKSPACE_BYTES,MAX_WORKSPACE_FILE_BYTES} from './verification.mjs';

const RACY_WRITE_WINDOW_MS = 50;
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
  workspace = canonicalWorkspace(workspace);
  const cacheKey = normalizeWorkspaceKey(workspace);
  let fileCache = workspaceCaches.get(cacheKey);
  if (!fileCache) {fileCache = new Map();workspaceCaches.set(cacheKey, fileCache);}
  const entries=Object.create(null),seen=new Set();let bytes=0;
  for(const rel of workspaceFiles(workspace)){
    const path=scopedPath(workspace,rel),stat=lstatSync(path);
    if((bytes+=stat.size)>MAX_SNAPSHOT_BYTES)throw Error('Workspace snapshot limit exceeded');
    seen.add(rel);const cached=fileCache.get(rel);
    if(rel!=='.codex/config.toml'&&!verifyHashes&&cached&&stat.size===cached.size&&stat.mtimeMs===cached.mtimeMs&&stat.ctimeMs===cached.ctimeMs&&stat.ino===cached.ino&&stat.dev===cached.dev&&stat.mtimeMs<Date.now()-RACY_WRITE_WINDOW_MS){
      hits++;entries[rel]=cached.hash;
    }else{
      misses++;
      const limit=rel==='.codex/config.toml'?32768:MAX_WORKSPACE_FILE_BYTES;
      const data=readBoundedBytes(path,Math.min(limit,MAX_SNAPSHOT_BYTES-(bytes-stat.size)));
      bytes+=data.length-stat.size;
      if(rel==='.codex/config.toml')noKnownSecrets(data.toString('utf8'));
      const hash=sha256(data);
      fileCache.set(rel,{size:data.length,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino,dev:stat.dev,hash});entries[rel]=hash;
    }
  }
  for(const cachedPath of fileCache.keys())if(!seen.has(cachedPath))fileCache.delete(cachedPath);
  return {entries,hash:sha256(entries)};
}
