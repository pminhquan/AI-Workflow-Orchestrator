import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export function verifyPathSafety(path) {
  if (typeof path !== 'string' || !path.trim()) throw Error('A non-empty path is required');
  const resolved = resolve(path);
  for (let current = resolved; dirname(current) !== current; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw Error('Symlinks/junctions rejected in path: ' + current);
    }
  }
  return resolved;
}

export function atomicWriteText(path, text, { exclusive = false } = {}) {
  verifyPathSafety(path);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = path + '.tmp-' + randomUUID();
  let fd;
  try {
    fd = openSync(tempPath, 'wx');
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (exclusive) linkSync(tempPath, path);
    else renameSync(tempPath, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function atomicWriteJSON(path, value, options) {
  atomicWriteText(path, JSON.stringify(value, null, 2) + '\n', options);
}

export function readBoundedBytes(path, limit) {
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const prior = lstatSync(path);
  if (!prior.isFile() || prior.size > limit) throw Error('Nonregular or oversized local file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!same(prior, stat)) throw Error('Local file changed before reading');
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const size = readSync(fd, buffer, count, buffer.length - count, null);
      if (size === 0) break;
      count += size;
    }
    if (count !== stat.size || !same(stat, fstatSync(fd)) || !same(stat, lstatSync(path))) {
      throw Error('Local file changed while reading');
    }
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}
