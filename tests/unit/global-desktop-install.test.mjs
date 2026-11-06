import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  symlinkSync
} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT, inside, sha256} from '../../src/core/util.mjs';
import {
  inspectGlobalBridgeStatus,
  planGlobalBridgeInstall,
  installGlobalBridge,
  uninstallGlobalBridge,
  buildCodexGlobalTomlBlock,
  buildGlobalHookEntry,
  buildCanonicalSidecarManifest,
  resolveGlobalTargets,
  resolveCanonicalSources,
  verifyPathSafety,
  CODEX_MCP_BEGIN_MARKER,
  CODEX_MCP_END_MARKER,
  HOOK_KEY,
  LIVE_DISCOVERY_NOT_VERIFIED
} from '../../src/desktop-inbox/global-install.mjs';
import {main, parseCliArgs} from '../../scripts/install-global-desktop-bridge.mjs';

test('config ancestor junctions and non-file targets fail before the first config write',()=>{
 const f=createFixture('target-boundary');try{
  const actual=resolve(f.base,'external-config');mkdirSync(actual);
  symlinkSync(actual,resolve(f.homeDir,'.codex'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>installGlobalBridge({homeDir:f.homeDir,stateDirectory:f.stateDir}),/Symlinks\/junctions/);
  assert.deepEqual(readdirSync(actual),[]);
  assert.equal(existsSync(resolve(f.homeDir,'.agents')),false);
 }finally{f.cleanup();}
 const g=createFixture('target-type');try{
  const target=resolveGlobalTargets({homeDir:g.homeDir});mkdirSync(target.workerSkill,{recursive:true});
  assert.throws(()=>installGlobalBridge({homeDir:g.homeDir,stateDirectory:g.stateDir}),/regular config file/);
  assert.equal(existsSync(target.codexConfig),false);
 }finally{g.cleanup();}
});

test('global coding guidance is merged once, activated by default and precisely rolled back',()=>{
 const f=createFixture('global-guidance');try{
  const target=resolveGlobalTargets({homeDir:f.homeDir});mkdirSync(resolve(f.homeDir,'.codex'));
  const original='# Existing user instructions\r\nKeep all permissions.\r\n';writeFileSync(target.codexGuidance,original);
  installGlobalBridge({homeDir:f.homeDir,stateDirectory:f.stateDir});
  const installed=readFileSync(target.codexGuidance,'utf8');
  assert.ok(installed.startsWith(original));assert.match(installed,/CURRENT Codex workspace/);assert.match(installed,/antigravity-orchestrator/);
  installGlobalBridge({homeDir:f.homeDir,stateDirectory:f.stateDir});assert.equal(readFileSync(target.codexGuidance,'utf8'),installed);
  const concurrent='\n# Later user preference\n';writeFileSync(target.codexGuidance,installed+concurrent);
  uninstallGlobalBridge({homeDir:f.homeDir,stateDirectory:f.stateDir});
  assert.equal(readFileSync(target.codexGuidance,'utf8'),original+concurrent);
 }finally{f.cleanup();}
});

test('rollback recovers the write-before-progress crash window using pre-recorded hashes',()=>{
 const f=createFixture('crash-window');try{
  const target=resolveGlobalTargets({homeDir:f.homeDir});mkdirSync(resolve(f.homeDir,'.codex'));
  const original='\n# original bytes\r\n\n';writeFileSync(target.codexConfig,original);
  assert.throws(()=>installGlobalBridge({homeDir:f.homeDir,stateDirectory:f.stateDir,failAfterWrite:1}),/before receipt progress/);
  const receipt=JSON.parse(readFileSync(resolve(f.stateDir,'receipt.json'),'utf8'));
  assert.deepEqual(receipt.completed_targets,[]);
  assert.ok(receipt.targets.filter(entry=>!entry.reused).every(entry=>/^[a-f0-9]{64}$/.test(entry.after_hash)));
  assert.throws(()=>installGlobalBridge({homeDir:f.homeDir,stateDirectory:f.stateDir}),/Interrupted installation/);
  uninstallGlobalBridge({homeDir:f.homeDir,stateDirectory:f.stateDir});
  assert.equal(readFileSync(target.codexConfig,'utf8'),original);
  assert.equal(existsSync(target.workerSkill),false);
 }finally{f.cleanup();}
});

function createFixture(label = 'global-install') {
  const rel = 'state/test-' + label + '-' + randomUUID();
  const base = resolve(ROOT, rel);
  const homeDir = resolve(base, 'user-home');
  const stateDir = resolve(base, 'bridge-state');
  mkdirSync(homeDir, {recursive: true});
  mkdirSync(stateDir, {recursive: true});

  return {
    rel,
    base,
    homeDir,
    stateDir,
    cleanup() {
      const state = resolve(ROOT, 'state');
      assert.ok(inside(state, base) && base !== state);
      rmSync(base, {recursive: true, force: true});
    }
  };
}

test('dry-run writes nothing to user home or state directory including --uninstall --dry-run', () => {
  const f = createFixture('dry-run');
  try {
    const installDryRun = installGlobalBridge({
      homeDir: f.homeDir,
      stateDirectory: f.stateDir,
      dryRun: true
    });

    assert.equal(installDryRun.status, 'DRY_RUN');
    assert.equal(installDryRun.dry_run, true);
    assert.equal(installDryRun.actions_planned.length, 6);

    // Confirm home directory remains completely empty
    assert.equal(readdirSync(f.homeDir).length, 0);

    // Confirm state directory remains completely empty (no receipt, no backups)
    assert.equal(readdirSync(f.stateDir).length, 0);

    // Now install for real, then test --uninstall --dry-run
    installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir});
    const targets = resolveGlobalTargets({homeDir: f.homeDir});
    assert.ok(existsSync(targets.codexConfig));

    const uninstallDryRun = uninstallGlobalBridge({
      homeDir: f.homeDir,
      stateDirectory: f.stateDir,
      dryRun: true
    });
    assert.equal(uninstallDryRun.status, 'DRY_RUN');
    assert.equal(uninstallDryRun.dry_run, true);

    // Confirm target files still exist after dry-run uninstall
    assert.ok(existsSync(targets.codexConfig));
    assert.ok(existsSync(targets.orchestratorSkill));
  } finally {
    f.cleanup();
  }
});

test('clean install and idempotence does not erase original rollback ownership', () => {
  const f = createFixture('clean-install');
  try {
    const targets = resolveGlobalTargets({homeDir: f.homeDir});
    const sources = resolveCanonicalSources();

    const installResult = installGlobalBridge({
      homeDir: f.homeDir,
      stateDirectory: f.stateDir,
      dryRun: false
    });

    assert.equal(installResult.status, 'INSTALLED');
    assert.ok(existsSync(installResult.receipt_path));

    // Check hook entry includes 4 events
    const hooksObj = JSON.parse(readFileSync(targets.geminiHooks, 'utf8'));
    assert.ok(Object.hasOwn(hooksObj, HOOK_KEY));
    const hook = hooksObj[HOOK_KEY];
    assert.ok(Array.isArray(hook.SessionStart));
    assert.ok(Array.isArray(hook.PreInvocation));
    assert.ok(Array.isArray(hook.PostInvocation));
    assert.ok(Array.isArray(hook.Stop));

    // Verify receipt content
    const receipt = JSON.parse(readFileSync(installResult.receipt_path, 'utf8'));
    assert.equal(receipt.status, 'INSTALLED');
    assert.equal(receipt.targets.filter(t => !t.reused).length, 6);

    // Idempotent second install must not erase original rollback ownership
    const secondRun = installGlobalBridge({
      homeDir: f.homeDir,
      stateDirectory: f.stateDir,
      dryRun: false
    });
    assert.equal(secondRun.status, 'ALREADY_INSTALLED');

    const receiptAfter = JSON.parse(readFileSync(installResult.receipt_path, 'utf8'));
    assert.equal(receiptAfter.status, 'INSTALLED');
    assert.equal(receiptAfter.targets.filter(t => !t.reused).length, 6);
  } finally {
    f.cleanup();
  }
});

test('preexisting matching files and sidecars survive rollback byte-for-byte', () => {
  const f = createFixture('preexisting-preservation');
  try {
    const targets = resolveGlobalTargets({homeDir: f.homeDir});
    const sources = resolveCanonicalSources();

    // 1. Pre-seed matching orchestrator skill
    mkdirSync(resolve(f.homeDir, '.agents/skills/antigravity-orchestrator'), {recursive: true});
    const canonicalOrchestrator = readFileSync(sources.orchestratorSkill, 'utf8');
    writeFileSync(targets.orchestratorSkill, canonicalOrchestrator, 'utf8');

    // 2. Pre-seed custom matching sidecar pointing to live-sidecar.mjs
    const customSidecarDir = resolve(targets.sidecarsDir, 'custom-sidecar');
    mkdirSync(customSidecarDir, {recursive: true});
    const customSidecarPath = resolve(customSidecarDir, 'sidecar.json');
    const customSidecarContent = JSON.stringify({
      command: 'custom-node.exe',
      args: [sources.liveSidecar],
      display_name: 'Custom Pre-existing Sidecar'
    }, null, 2) + '\n';
    writeFileSync(customSidecarPath, customSidecarContent, 'utf8');

    // 3. Install
    const installResult = installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir});
    assert.equal(installResult.status, 'INSTALLED');

    // Confirm that duplicate awo-bridge sidecar was NOT created
    assert.ok(!existsSync(targets.sidecarManifest));

    // Confirm receipt recorded orchestrator and sidecar as reused/existed_before
    const receipt = JSON.parse(readFileSync(installResult.receipt_path, 'utf8'));
    const orchestratorEntry = receipt.targets.find(t => t.id === 'orchestrator_skill');
    assert.equal(orchestratorEntry.existed_before, true);
    assert.equal(orchestratorEntry.reused, true);

    const sidecarEntry = receipt.targets.find(t => t.id === 'sidecar_manifest');
    assert.equal(sidecarEntry.existed_before, true);
    assert.equal(sidecarEntry.reused, true);

    // 4. Uninstall
    const unResult = uninstallGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir});
    assert.equal(unResult.status, 'UNINSTALLED');

    // 5. Preexisting skill and preexisting sidecar MUST STILL EXIST byte-for-byte!
    assert.ok(existsSync(targets.orchestratorSkill));
    assert.equal(readFileSync(targets.orchestratorSkill, 'utf8'), canonicalOrchestrator);

    assert.ok(existsSync(customSidecarPath));
    assert.equal(readFileSync(customSidecarPath, 'utf8'), customSidecarContent);

    // Historical receipt is kept with status UNINSTALLED
    const receiptFinal = JSON.parse(readFileSync(installResult.receipt_path, 'utf8'));
    assert.equal(receiptFinal.status, 'UNINSTALLED');
  } finally {
    f.cleanup();
  }
});

test('no-receipt uninstall fails cleanly and preserves unmanaged state', () => {
  const f = createFixture('no-receipt');
  try {
    assert.throws(
      () => uninstallGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir}),
      /missing durable installation receipt/i
    );
  } finally {
    f.cleanup();
  }
});

test('owned block drift during install rejects mutation without appending second table', () => {
  const f = createFixture('drift-install');
  try {
    const targets = resolveGlobalTargets({homeDir: f.homeDir});

    mkdirSync(resolve(f.homeDir, '.codex'), {recursive: true});
    const driftedBlock = [
      CODEX_MCP_BEGIN_MARKER,
      '[mcp_servers.desktop_inbox]',
      'command = "node"',
      'args = ["drifted-path.mjs"]',
      'startup_timeout_sec = 999',
      CODEX_MCP_END_MARKER
    ].join('\n') + '\n';
    writeFileSync(targets.codexConfig, driftedBlock, 'utf8');

    assert.throws(
      () => installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir}),
      /Owned content drift/i
    );

    // Verify config.toml was NOT modified and second table was NOT appended
    assert.equal(readFileSync(targets.codexConfig, 'utf8'), driftedBlock);
  } finally {
    f.cleanup();
  }
});

test('duplicate Sidecars pointing to live-sidecar are detected and fail preflight', () => {
  const f = createFixture('duplicate-sidecars');
  try {
    const targets = resolveGlobalTargets({homeDir: f.homeDir});
    const sources = resolveCanonicalSources();

    const dir1 = resolve(targets.sidecarsDir, 'sidecar-one');
    const dir2 = resolve(targets.sidecarsDir, 'sidecar-two');
    mkdirSync(dir1, {recursive: true});
    mkdirSync(dir2, {recursive: true});

    const manifest = {command: 'node', args: [sources.liveSidecar]};
    writeFileSync(resolve(dir1, 'sidecar.json'), JSON.stringify(manifest), 'utf8');
    writeFileSync(resolve(dir2, 'sidecar.json'), JSON.stringify(manifest), 'utf8');

    assert.throws(
      () => installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir}),
      /Duplicate sidecar registrations/i
    );
  } finally {
    f.cleanup();
  }
});

test('links and junctions are rejected in target and state paths', () => {
  const f = createFixture('links-junctions');
  try {
    const realTargetDir = resolve(f.base, 'real-target');
    const junctionDir = resolve(f.base, 'junction-target');
    mkdirSync(realTargetDir, {recursive: true});

    symlinkSync(realTargetDir, junctionDir, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
      () => verifyPathSafety(junctionDir),
      /Symlinks\/junctions rejected/i
    );

    assert.throws(
      () => installGlobalBridge({homeDir: junctionDir, stateDirectory: f.stateDir}),
      /Symlinks\/junctions rejected/i
    );
  } finally {
    f.cleanup();
  }
});

test('invalid hook root shape is rejected before mutations', () => {
  const f = createFixture('invalid-hook-root');
  try {
    const targets = resolveGlobalTargets({homeDir: f.homeDir});
    mkdirSync(resolve(f.homeDir, '.gemini/config'), {recursive: true});
    writeFileSync(targets.geminiHooks, '["not", "a", "plain", "object"]\n', 'utf8');

    assert.throws(
      () => installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir}),
      /expected a plain JSON object/i
    );

    assert.ok(!existsSync(targets.codexConfig));
  } finally {
    f.cleanup();
  }
});

test('interruption recovery rolls back partially installed assets safely', () => {
  const f = createFixture('interruption-recovery');
  try {
    const targets = resolveGlobalTargets({homeDir: f.homeDir});

    // Simulate failure after action 1 (codex_mcp)
    assert.throws(
      () => installGlobalBridge({
        homeDir: f.homeDir,
        stateDirectory: f.stateDir,
        failAfterAction: 1
      }),
      /Simulated installation failure after action 1/
    );

    // codexConfig was written
    assert.ok(existsSync(targets.codexConfig));
    // Subsequent targets were not written
    assert.ok(!existsSync(targets.workerSkill));

    // Receipt exists with IN_PROGRESS and 1 completed target
    const receipt = JSON.parse(readFileSync(resolve(f.stateDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'IN_PROGRESS');
    assert.deepEqual(receipt.completed_targets, ['codex_mcp']);

    // Call uninstall to recover
    const unResult = uninstallGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir});
    assert.equal(unResult.status, 'UNINSTALLED');

    // codexConfig was safely removed
    assert.ok(!existsSync(targets.codexConfig));
  } finally {
    f.cleanup();
  }
});

test('custom rollback args recorded in receipt reflect injected parameters', () => {
  const f = createFixture('custom-args');
  try {
    const customNode = resolve(f.base, 'custom-node.exe');
    const res = installGlobalBridge({
      homeDir: f.homeDir,
      stateDirectory: f.stateDir,
      nodePath: customNode,
      rootDir: ROOT
    });

    const receipt = JSON.parse(readFileSync(res.receipt_path, 'utf8'));
    assert.ok(receipt.rollback_command.includes(customNode));
    assert.ok(receipt.rollback_command.includes(`--home '${f.homeDir}'`));
    assert.ok(receipt.rollback_command.includes(`--state '${f.stateDir}'`));
    assert.ok(receipt.rollback_command.includes(`--root '${ROOT}'`));
    assert.ok(receipt.rollback_command.includes(`--node '${customNode}'`));
  } finally {
    f.cleanup();
  }
});

test('byte-for-byte unrelated TOML preservation across install and uninstall', () => {
  const f = createFixture('toml-preservation');
  try {
    const targets = resolveGlobalTargets({homeDir: f.homeDir});
    mkdirSync(resolve(f.homeDir, '.codex'), {recursive: true});

    const initialToml = [
      '# Custom User TOML File with Peculiar Formatting',
      '',
      '[general]',
      'default_model = "gpt-5"',
      '',
      '  # Indented comment',
      '[settings.network]',
      'timeout = 42',
      ''
    ].join('\n');

    writeFileSync(targets.codexConfig, initialToml, 'utf8');

    // Install
    installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir});

    const afterInstall = readFileSync(targets.codexConfig, 'utf8');
    assert.ok(afterInstall.includes(CODEX_MCP_BEGIN_MARKER));
    assert.ok(afterInstall.startsWith(initialToml));

    // Uninstall
    uninstallGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDir});

    const afterUninstall = readFileSync(targets.codexConfig, 'utf8');
    // MUST BE BYTE-FOR-BYTE IDENTICAL
    assert.equal(afterUninstall, initialToml);
  } finally {
    f.cleanup();
  }
});

test('CLI script execution and flags', () => {
  const f = createFixture('cli');
  try {
    assert.deepEqual(parseCliArgs(['--install', '--dry-run']), {
      mode: 'install',
      dryRun: true,
      homeDir: undefined,
      stateDirectory: undefined,
      nodePath: undefined,
      rootDir: undefined
    });

    const dryRunResult = main(['--install', '--dry-run', '--home', f.homeDir, '--state', f.stateDir]);
    assert.equal(dryRunResult.status, 'DRY_RUN');

    const installResult = main(['--install', '--home', f.homeDir, '--state', f.stateDir]);
    assert.equal(installResult.status, 'INSTALLED');

    const statusResult = main(['--status', '--home', f.homeDir, '--state', f.stateDir]);
    assert.equal(statusResult.installation_status, 'INSTALLED');
    assert.equal(statusResult.live_discovery, LIVE_DISCOVERY_NOT_VERIFIED);

    const uninstallResult = main(['--uninstall', '--home', f.homeDir, '--state', f.stateDir]);
    assert.equal(uninstallResult.status, 'UNINSTALLED');
  } finally {
    f.cleanup();
  }
});
