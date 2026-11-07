import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, inside, sha256 } from '../src/core/util.mjs';
import { atomicWriteJSON, atomicWriteText, verifyPathSafety } from '../src/core/local-files.mjs';

const GUIDANCE = ['<!-- antigravity-chat:start -->', '<!-- antigravity-chat:end -->'];
const MCP = ['# BEGIN AWO ANTIGRAVITY GUI', '# END AWO ANTIGRAVITY GUI'];
const SECTION = /^\s*\[\s*["']?mcp_servers["']?\s*\.\s*["']?antigravity_gui["']?\s*\]/m;
const quote = value => JSON.stringify(value.replaceAll('\\', '/'));

export function buildMcpBlock(root = ROOT, node = process.execPath) {
  return [
    MCP[0],
    '[mcp_servers.antigravity_gui]',
    'command = ' + quote(node),
    'args = [' + quote(resolve(root, 'src/chat-jobs.mjs')) + ', "serve"]',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 35',
    MCP[1]
  ].join('\n');
}

function buildGuidance() {
  return [
    GUIDANCE[0],
    '## Giao việc qua chat Antigravity',
    'Dùng skill antigravity-jobs và MCP antigravity_gui để nhập và submit brief một lần vào chat đang mở của đúng project. CLI của skill dùng cùng luồng nếu MCP chưa được phiên Codex nạp.',
    'Bạn chọn chat, project và model trên GUI. Sender dùng Windows background messages và giữ cửa sổ đang dùng. Giữ bản nháp có sẵn. Chat trống nhận job ngay, chat bận dùng hàng chờ gốc của Anti.',
    'Giữ job_path trả về và đọc status mỗi 5 phút trong lúc làm phần việc độc lập. Khi Anti xong, giao phần độc lập tiếp theo nếu còn.',
    GUIDANCE[1]
  ].join('\n');
}

function current(file) {
  verifyPathSafety(file);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function marked(text, [start, end]) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 && to < 0) return null;
  if (from < 0 || to < from || text.indexOf(start, from + start.length) >= 0 ||
      text.indexOf(end, to + end.length) >= 0) throw Error('Ambiguous managed configuration markers');
  return text.slice(from, to + end.length);
}

function targets(home) {
  return {
    skill: resolve(home, '.codex/skills/antigravity-jobs/SKILL.md'),
    guidance: resolve(home, '.codex/AGENTS.md'),
    mcp: resolve(home, '.codex/config.toml')
  };
}

function receiptLocation(root, state) {
  const file = verifyPathSafety(resolve(root, state, 'receipt.json'));
  if (!inside(resolve(root, 'state'), file)) throw Error('Installation receipt must stay in project state');
  return file;
}

function markedChange(key, path, block, markers) {
  const before = current(path);
  const text = before ?? '';
  const previous = marked(text, markers);
  if (key === 'mcp' && SECTION.test(previous ? text.replace(previous, '') : text)) {
    throw Error('An unmanaged antigravity_gui MCP section already exists');
  }
  if (key === 'mcp' && previous && previous !== block) throw Error('The installed MCP block differs from the planned one');
  const inserted = previous ? block : (text && !text.endsWith('\n\n') ? (text.endsWith('\n') ? '\n' : '\n\n') : '') + block + '\n';
  const after = previous ? text.replace(previous, block) : text + inserted;
  return { key, path, before, after, previous, installed: block, inserted };
}

export function installChatJobs({ home = homedir(), root = ROOT, state = 'state/antigravity-gui-install', dryRun = false } = {}) {
  const paths = targets(home);
  const receiptPath = receiptLocation(root, state);
  const beforeSkill = current(paths.skill);
  const skill = readFileSync(resolve(root, '.agents/skills/antigravity-jobs/SKILL.md'), 'utf8')
    .replaceAll('{{WORKFLOW_ROOT}}', root.replaceAll('\\', '/'));
  if (beforeSkill !== null && beforeSkill !== skill) throw Error('The installed antigravity-jobs skill has different content');
  const changes = [
    { key: 'skill', path: paths.skill, before: beforeSkill, after: skill },
    markedChange('guidance', paths.guidance, buildGuidance(), GUIDANCE),
    markedChange('mcp', paths.mcp, buildMcpBlock(root), MCP)
  ].filter(item => item.before !== item.after);
  const keys = changes.map(item => item.key);
  if (dryRun || changes.length === 0) return { state: dryRun ? 'preview' : 'installed', changes: keys };
  if (existsSync(receiptPath) && JSON.parse(readFileSync(receiptPath, 'utf8')).state !== 'uninstalled') {
    throw Error('Review the existing installation before updating');
  }
  const backupDir = resolve(dirname(receiptPath), 'backups', randomUUID());
  mkdirSync(backupDir, { recursive: true });
  const files = changes.map(({ before, after, ...entry }) => {
    if (before !== null) atomicWriteText(resolve(backupDir, entry.key + '.bak'), before);
    return { ...entry, before_hash: before === null ? null : sha256(before), after_hash: sha256(after) };
  });
  const receipt = { state: 'prepared', root, home, files, backup_dir: backupDir };
  atomicWriteJSON(receiptPath, receipt);
  for (const change of changes) {
    if (current(change.path) !== change.before) throw Error('Concurrent configuration edit in ' + change.key);
    atomicWriteText(change.path, change.after);
  }
  receipt.state = 'installed';
  atomicWriteJSON(receiptPath, receipt);
  return { state: 'installed', changes: keys, receipt_path: receiptPath };
}

export function uninstallChatJobs({ home = homedir(), root = ROOT, state = 'state/antigravity-gui-install', dryRun = false } = {}) {
  const receiptPath = receiptLocation(root, state);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.root !== root || receipt.home !== home || !Array.isArray(receipt.files)) throw Error('Invalid installation receipt');
  if (receipt.state === 'uninstalled') return { state: 'uninstalled', changes: [] };
  const paths = targets(home);
  const replacements = [];
  const seen = new Set();
  for (const entry of receipt.files) {
    if (!Object.hasOwn(paths, entry.key) || paths[entry.key] !== entry.path || seen.has(entry.key)) throw Error('Invalid receipt target');
    seen.add(entry.key);
    const text = current(entry.path);
    const hash = text === null ? null : sha256(text);
    if (hash === entry.before_hash) continue;
    let restored = null;
    if (entry.key === 'skill') {
      if (hash !== entry.after_hash) throw Error('Owned skill changed');
      if (entry.before_hash !== null) {
        const backup = verifyPathSafety(resolve(receipt.backup_dir, 'skill.bak'));
        if (!inside(resolve(dirname(receiptPath), 'backups'), backup)) throw Error('Invalid backup path');
        restored = readFileSync(backup, 'utf8');
        if (sha256(restored) !== entry.before_hash) throw Error('Backup content changed');
      }
    } else {
      if (marked(text ?? '', entry.key === 'mcp' ? MCP : GUIDANCE) !== entry.installed ||
          !text.includes(entry.inserted)) throw Error('Owned configuration changed: ' + entry.key);
      restored = text.replace(entry.inserted, entry.previous ?? '');
      if (!restored && entry.before_hash === null) restored = null;
    }
    replacements.push({ path: entry.path, before: text, after: restored });
  }
  const changes = replacements.map(item => item.path);
  if (dryRun) return { state: 'preview', changes };
  for (const change of replacements) {
    if (current(change.path) !== change.before) throw Error('Concurrent configuration edit');
    if (change.after === null) unlinkSync(change.path);
    else atomicWriteText(change.path, change.after);
  }
  receipt.state = 'uninstalled';
  atomicWriteJSON(receiptPath, receipt);
  return { state: 'uninstalled', changes };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--install', '--uninstall', '--dry-run'].includes(arg)) ||
        args.includes('--install') === args.includes('--uninstall')) throw Error('Choose --install or --uninstall with optional --dry-run');
    const options = { dryRun: args.includes('--dry-run') };
    const result = args.includes('--uninstall') ? uninstallChatJobs(options) : installChatJobs(options);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
