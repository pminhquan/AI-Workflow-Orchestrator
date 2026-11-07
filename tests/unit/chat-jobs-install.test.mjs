import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, inside } from '../../src/core/util.mjs';
import { buildMcpBlock, installChatJobs, uninstallChatJobs } from '../../scripts/install-chat-jobs.mjs';

function fixture(t) {
  const suffix = 'test-gui-install-' + randomUUID();
  const folder = resolve(ROOT, 'state', suffix);
  const home = resolve(folder, 'home');
  const state = 'state/' + suffix + '/install';
  mkdirSync(resolve(home, '.codex'), { recursive: true });
  t.after(() => {
    assert.ok(folder !== resolve(ROOT, 'state') && inside(resolve(ROOT, 'state'), folder));
    rmSync(folder, { recursive: true, force: true });
  });
  return { home, state, config: resolve(home, '.codex/config.toml'), guidance: resolve(home, '.codex/AGENTS.md') };
}

test('MCP install and rollback preserve other configuration and guidance', t => {
  const f = fixture(t);
  const config = '[mcp_servers.personal]\ncommand = "personal"\n';
  const guidance = '# Personal instructions\n\n<!-- antigravity-chat:start -->\nOld chat guidance\n<!-- antigravity-chat:end -->\n';
  const later = '\n# Later preference\n';
  writeFileSync(f.config, config);
  writeFileSync(f.guidance, guidance);
  const preview = installChatJobs({ ...f, dryRun: true });
  assert.deepEqual(preview.changes, ['skill', 'guidance', 'mcp']);
  assert.equal(readFileSync(f.config, 'utf8'), config);
  installChatJobs(f);
  const skill = resolve(f.home, '.codex/skills/antigravity-jobs/SKILL.md');
  assert.match(readFileSync(skill, 'utf8'), /^---\r?\nname: antigravity-jobs/);
  assert.doesNotMatch(readFileSync(skill, 'utf8'), /\{\{WORKFLOW_ROOT\}\}/);
  assert.ok(readFileSync(f.config, 'utf8').includes(buildMcpBlock()));
  assert.deepEqual(installChatJobs(f).changes, []);
  assert.equal(existsSync(resolve(f.home, '.gemini')), false);
  writeFileSync(f.config, readFileSync(f.config, 'utf8') + later);
  writeFileSync(f.guidance, readFileSync(f.guidance, 'utf8') + later);
  uninstallChatJobs(f);
  assert.equal(readFileSync(f.config, 'utf8'), config + later);
  assert.equal(readFileSync(f.guidance, 'utf8'), guidance + later);
  assert.equal(existsSync(skill), false);
  installChatJobs(f);
  assert.equal(uninstallChatJobs(f).state, 'uninstalled');
});

test('installer refuses unmanaged name collisions and preserves the existing server', t => {
  const f = fixture(t);
  const original = '[mcp_servers."antigravity_gui"]\ncommand = "personal"\n';
  writeFileSync(f.config, original);
  assert.throws(() => installChatJobs(f), /unmanaged/);
  assert.equal(readFileSync(f.config, 'utf8'), original);
  assert.equal(existsSync(f.guidance), false);
});
