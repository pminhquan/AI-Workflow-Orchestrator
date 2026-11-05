import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync, symlinkSync, realpathSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT, inside, sha256} from '../../src/core/util.mjs';
import {scanPublicationFile, assertPublicationSafe} from '../../scripts/publication-security.mjs';
import {buildPlan, writeOutput, verifyOutput, verifyPublicationHistory, publicationInventory, MANIFEST} from '../../scripts/publication.mjs';

function fixture(fn) {
  const state = resolve(ROOT, 'state'); mkdirSync(state, {recursive: true});
  const dir = mkdtempSync(resolve(state, 'publication-test-'));
  const canonical = resolve(dir, 'canonical'), output = resolve(dir, 'export');
  mkdirSync(resolve(canonical, 'src'), {recursive: true});
  writeFileSync(resolve(canonical, 'src/example.mjs'), 'export const answer = 42;\r\n');
  writeFileSync(resolve(canonical, '.gitattributes'), '* text=auto eol=lf\n');
  const policy = {schema_version: '1', include: ['src/example.mjs', '.gitattributes'], optional: [], exclude: {}, projections: {'.gitattributes': 'publication-attributes'}};
  const plan = () => buildPlan({root: canonical, policy, inventory: policy.include, commit: '0'.repeat(40)});
  const put = (file, value) => { const path = resolve(canonical, file); mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, value); };
  try { return fn({dir, canonical, output, policy, plan, put}); }
  finally {
    if (!inside(realpathSync(state), realpathSync(dir)) || realpathSync(dir) === realpathSync(state)) throw Error('Unsafe publication test cleanup');
    rmSync(dir, {recursive: true, force: true});
  }
}
function runGit(cwd, args, expected = 0) {
  const result = spawnSync('git', args, {cwd, windowsHide: true, shell: false, encoding: 'utf8'});
  assert.equal(result.status, expected, 'Local fixture Git operation failed');
  return result.stdout;
}
test('publication .gitignore blocks dummy private paths while keeping all essential inputs', () => fixture(({canonical}) => {
  writeFileSync(resolve(canonical, '.gitignore'), readFileSync(resolve(ROOT, '.gitignore')));
  runGit(canonical, ['init', '-q']);
  const blocked = ['.env', '.env.local', '.codex/auth.json', '.codex/sessions/private.jsonl', '.gemini/config/mcp_config.json', 'auth.json', 'nested/auth.local.json', 'tokens.json', 'secrets.local.json', 'mcp_config.json', 'bridge.config.json', 'worker_token.txt', 'worker-capability.json', 'cookies.json', 'session.json', 'sessions/a.json', 'transcripts/a.json', 'runtime/a.json', 'logs/events.jsonl', 'events.ndjson', 'state/private.json', 'data.db-wal', 'data.sqlite-shm', 'identity.p12', 'identity.pfx', 'backup.zip', 'archive.7z', 'backup.bak', '.cache/a.json', '.pytest_cache/a', '__pycache__/a.pyc', 'a.tmp.123', 'build/output.js', 'node_modules/a.json'];
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {cwd: canonical, input: blocked.join('\n') + '\n', encoding: 'utf8', windowsHide: true});
  assert.deepEqual(new Set(result.stdout.trim().split(/\r?\n/)), new Set(blocked));
  const policy = JSON.parse(readFileSync(resolve(ROOT, 'config/publication/allowlist.json'), 'utf8'));
  const allowed = [...policy.include, '.env.example'];
  const essential = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {cwd: canonical, input: allowed.join('\n') + '\n', encoding: 'utf8', windowsHide: true});
  assert.equal(essential.status, 1); assert.equal(essential.stdout, '');
}));
test('publication scan blocks constructed dummy tokens and never reports matched values', () => {
  const dummy = 'gh' + 'p_' + 'A'.repeat(36);
  const findings = scanPublicationFile('src/example.mjs', Buffer.from(dummy));
  assert.ok(findings.some(f => f.type === 'github-token'));
  assert.ok(!JSON.stringify(findings).includes(dummy));
  const assignment = JSON.stringify({['worker_' + 'token']: 'constructed-' + 'a9B2'.repeat(12)});
  assert.ok(scanPublicationFile('config/example.json', Buffer.from(assignment)).length);
  const unquoted = 'API_' + 'KEY=' + 'constructed-placeholder-value';
  assert.ok(scanPublicationFile('config/local.ini', Buffer.from(unquoted)).some(f => f.type === 'unquoted-secret-assignment'));
  assert.ok(scanPublicationFile('config/local.json', Buffer.from(JSON.stringify({['capabi' + 'lity']: 'constructed-' + 'ab12'.repeat(12)}))).some(f => f.type === 'capability-assignment'));
  assert.deepEqual(scanPublicationFile('docs/hashes.json', Buffer.from(JSON.stringify({'config/integrations/capabilities.json': 'a'.repeat(64)}))), []);
  assert.deepEqual(scanPublicationFile('src/example.mjs', Buffer.from("const result = {critical_capability: 'parallel'};")), []);
  assert.deepEqual(scanPublicationFile('src/example.mjs', Buffer.from("const result = {reason: 'Unavailable capability: '+missing.join(', ')};")), []);
  assert.ok(scanPublicationFile('sessions/example.txt', Buffer.from('local')).some(f => f.type === 'private-runtime-path'));
  assert.throws(() => assertPublicationSafe({'data.bin': Buffer.from([0, 1, 2])}), /security gate/);
});
test('publication scan retains explicit negative-test fixtures and public pinned attribution', () => {
  const fixture = 'const t = {worker_' + "token: 'not-a-real-token'};";
  assert.deepEqual(scanPublicationFile('tests/unit/example.mjs', Buffer.from(fixture)), []);
  const url = 'https://github.com/example/SourceV2/blob/' + 'ab12'.repeat(10) + '/README.md';
  assert.deepEqual(scanPublicationFile('docs/sources.md', Buffer.from(url)), []);
});
test('publication fails closed on unknown or missing source files', () => fixture(({canonical, policy}) => {
  assert.throws(() => buildPlan({root: canonical, policy, inventory: ['src/example.mjs', 'unclassified.txt'], commit: '0'.repeat(40)}), /Unclassified/);
  assert.throws(() => buildPlan({root: canonical, policy, inventory: [], commit: '0'.repeat(40)}), /Required/);
}));
test('publication inventories ignored source fixtures instead of silently publishing stale code', () => fixture(({canonical, policy, put}) => {
  put('.gitignore', '*.jsonl\nstate/\n'); policy.include.push('.gitignore');
  put('tests/unclassified.jsonl', '{}\n'); put('state/private.jsonl', '{}\n'); runGit(canonical, ['init', '-q']);
  const inventory = publicationInventory(canonical);
  assert.ok(inventory.includes('tests/unclassified.jsonl')); assert.ok(!inventory.includes('state/private.jsonl'));
  assert.throws(() => buildPlan({root: canonical, policy, inventory, commit: '0'.repeat(40)}), /Unclassified/);
}));
test('publication cannot project implementation or test semantics', () => fixture(({policy, plan}) => {
  policy.projections['src/example.mjs'] = 'readme-checkout';
  assert.throws(plan, /byte-identical/);
}));
test('publication scans source credentials before a document projection', () => fixture(({policy, put, plan, output}) => {
  policy.include.push('README.md'); policy.projections['README.md'] = 'readme-checkout';
  put('README.md', 'gh' + 'p_' + 'A'.repeat(36));
  assert.throws(plan, /security gate/); assert.equal(existsSync(output), false);
}));
test('publication JSON parse failures do not echo input values', () => fixture(({policy, put, plan}) => {
  policy.include.push('config/deployment/components.json'); policy.projections['config/deployment/components.json'] = 'deployment-projection';
  const privateText = 'invalid-private-input'; put('config/deployment/components.json', privateText);
  assert.throws(plan, error => error.message === 'Invalid JSON in config/deployment/components.json' && !error.message.includes(privateText));
}));
test('publication is deterministic, preserves source bytes and creates no Git history', () => fixture(({canonical, output, plan}) => {
  const first = plan(), second = plan(); assert.deepEqual(first.files, second.files);
  writeOutput(output, first, canonical); assert.equal(existsSync(resolve(output, '.git')), false);
  assert.deepEqual(readFileSync(resolve(output, 'src/example.mjs')), readFileSync(resolve(canonical, 'src/example.mjs')));
  assert.equal(verifyOutput(output, second).status, 'OFFLINE-TESTED');
  writeOutput(output, second, canonical); assert.deepEqual(readFileSync(resolve(output, MANIFEST)), first.files[MANIFEST]);
}));
test('publication allows only guarded ignored staging inside canonical', () => fixture(({canonical, plan}) => {
  const output=resolve(canonical,'state/publication/v22-review');
  writeOutput(output,plan(),canonical);assert.equal(verifyOutput(output,plan()).status,'OFFLINE-TESTED');
  for(const bad of [canonical,resolve(canonical,'src/export'),resolve(canonical,'state/publication'),resolve(canonical,'state/publication/v22/nested')])assert.throws(()=>writeOutput(bad,plan(),canonical),/separate publication/);
}));
test('publication detects stale canonical inputs and refreshes only owned output', () => fixture(({canonical, output, plan, put}) => {
  const first = plan(); writeOutput(output, first, canonical);
  put('src/example.mjs', 'export const answer = 43;\n'); const next = plan();
  assert.notEqual(first.inputFingerprint, next.inputFingerprint);
  assert.throws(() => verifyOutput(output, next), /Stale/);
  writeOutput(output, next, canonical); assert.equal(verifyOutput(output, next).status, 'OFFLINE-TESTED');
}));
test('publication refuses unmanaged, locally edited and unclassified output', () => fixture(({canonical, output, plan}) => {
  mkdirSync(output); writeFileSync(resolve(output, 'personal.txt'), 'local');
  assert.throws(() => writeOutput(output, plan(), canonical), /unmanaged/);
}));
test('publication preserves out-of-band edits by refusing refresh', () => fixture(({canonical, output, plan}) => {
  const p = plan(); writeOutput(output, p, canonical);
  writeFileSync(resolve(output, 'src/example.mjs'), 'local edit\n');
  assert.throws(() => writeOutput(output, p, canonical), /Out-of-band/);
  writeFileSync(resolve(output, 'src/example.mjs'), p.files['src/example.mjs']);
  writeFileSync(resolve(output, 'unknown.txt'), 'unclassified\n');
  assert.throws(() => writeOutput(output, p, canonical), /Unclassified/);
}));
test('publication projection removes machine targets without fabricating a V1 baseline', () => fixture(({canonical, output, policy, put, plan}) => {
  policy.include.push('config/deployment/components.json'); policy.projections['config/deployment/components.json'] = 'deployment-projection';
  const input = {schema_version: '1.0', activation: 'foundation-only', components: [{management: 'legacy-reference', installed_target_path: 'C:' + '\\Users\\private\\config', canonical_source_path: 'legacy/private.json', content_hash: 'a'.repeat(64)}, {management: 'staged', installed_target_path: 'D:' + '\\PROJECT\\private', canonical_source_path: 'agents/generated/example.json', content_hash: 'b'.repeat(64)}]};
  put('config/deployment/components.json', JSON.stringify(input));
  const p = plan(); const projected = JSON.parse(p.files['config/deployment/components.json']);
  assert.ok(projected.components.every(c => c.installed_target_path === null));
  assert.equal(projected.components[0].content_hash, null); assert.equal(projected.components[1].content_hash, input.components[1].content_hash);
  writeOutput(output, p, canonical); assert.equal(existsSync(resolve(output, 'legacy/v1-inventory.json')), false);
}));
test('publication rejects path traversal and links before reading input', () => fixture(({canonical, dir, policy, plan}) => {
  policy.include = ['../outside']; assert.throws(plan, /Unsafe/);
  policy.include = ['linked/data.txt']; policy.projections = {}; mkdirSync(resolve(dir, 'outside')); writeFileSync(resolve(dir, 'outside/data.txt'), 'safe');
  symlinkSync(resolve(dir, 'outside'), resolve(canonical, 'linked'), 'junction');
  assert.throws(plan, /Links|junction/);
}));
test('publication history gate rejects personal identities and accepts clean noreply history', () => fixture(({canonical, output, plan}) => {
  const p = plan(); writeOutput(output, p, canonical); runGit(output, ['init', '-q', '--initial-branch=main']);
  runGit(output, ['add', '--', '.']);
  const identity = ['-c', 'user.name=reviewer', '-c', 'user.email=12345+reviewer@users.noreply.github.com'];
  runGit(output, [...identity, 'commit', '-q', '-m', 'Sanitized publication fixture']);
  assert.equal(verifyPublicationHistory(output).commits, 1);
  assert.equal(verifyOutput(output, p).status, 'OFFLINE-TESTED');
  const privateIdentity = ['-c', 'user.name=reviewer', '-c', 'user.email=' + 'private' + '@' + 'example.invalid'];
  runGit(output, [...privateIdentity, 'commit', '-q', '--allow-empty', '-m', 'Rejected identity fixture']);
  assert.throws(() => verifyPublicationHistory(output), /noreply/);
}));
