import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync
} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT, inside, sha256, scopedPath} from '../../src/core/util.mjs';
import {canonicalWorkspace} from '../../src/desktop-inbox/contracts.mjs';
import {
  installGlobalBridge,
  uninstallGlobalBridge,
  resolveGlobalTargets,
  CODEX_MCP_BEGIN_MARKER,
  CODEX_MCP_END_MARKER,
  HOOK_KEY
} from '../../src/desktop-inbox/global-install.mjs';
import {createReviewedToolHandler as createLiveToolHandler} from '../desktop-review-fixtures.mjs';
import {runLiveSidecarTick} from '../../src/desktop-inbox/live-sidecar.mjs';
import {submitWorkerReport} from '../../src/desktop-inbox/report-cli.mjs';
import {
  selectVerifiedReceiver,
  readSelectedReceiver,
  readJobReceiver
} from '../../src/desktop-inbox/selected-receiver.mjs';
import {processBeaconInput} from '../../src/desktop-inbox/hook-beacon.mjs';
import {openLiveInbox, listLiveWorkspaces} from '../../src/desktop-inbox/live-bridge.mjs';

function createFixture(label = 'global-bridge') {
  const rel = `state/test-${label}-${randomUUID()}`;
  const root = resolve(ROOT, rel);
  const homeDir = resolve(root, 'user-home');
  const stateDirectory = `${rel}/bridge-state`;
  const rootA = resolve(root, 'project-a');
  const rootB = resolve(root, 'project-b');

  mkdirSync(homeDir, {recursive: true});
  mkdirSync(resolve(ROOT, stateDirectory), {recursive: true});
  mkdirSync(rootA, {recursive: true});
  mkdirSync(rootB, {recursive: true});
  writeFileSync(resolve(rootA, 'README.md'), '# Project A\nNon-onboarded standalone repository.\n');
  writeFileSync(resolve(rootB, 'README.md'), '# Project B\nNon-onboarded standalone repository.\n');

  return {
    rel,
    root,
    homeDir,
    stateDirectory,
    rootA,
    rootB,
    cleanup() {
      const stateRoot = resolve(ROOT, 'state');
      assert.ok(inside(stateRoot, root) && root !== stateRoot);
      rmSync(root, {recursive: true, force: true});
    }
  };
}

test('corrupt saved receiver proof is rejected by status before it can claim readiness',async()=>{
 const f=createFixture('saved-proof');try{
  const selection={format:'desktop-inbox.selected-receiver@1',enabled:true,conversation_id:'valid-looking-chat',selected_at:new Date().toISOString(),verified_task_id:randomUUID(),verified_attempt_id:randomUUID(),host_receipt_sha256:sha256('receipt'),proves_gui_focus:true};
  writeFileSync(resolve(ROOT,f.stateDirectory,'selected-receiver.json'),JSON.stringify(selection));
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  await assert.rejects(call('bridge_status',{workspace_root:f.rootA}),/SELECTED_RECEIVER_INVALID/);
  await assert.rejects(call('submit_job',{workspace_root:f.rootA,request:'Read README',read_scope:['README.md'],write_scope:[],acceptance_criteria:['Read accurately']}),/SELECTED_RECEIVER_INVALID/);
 }finally{f.cleanup();}
});

const mockSuccessfulTransport = (outputSha = sha256('delivered')) => ({
  started: true,
  exit_code: 0,
  spawn_error: null,
  exit_signal: null,
  timed_out: false,
  output_overflow: false,
  stdout_sha256: outputSha,
  stderr_sha256: sha256(''),
  stdout_bytes: 9,
  stderr_bytes: 0
});

test('global desktop bridge end-to-end lifecycle: install, multi-root isolation, sidecar dispatch, worker report, receiver selection, strict routing, and uninstall', async () => {
  const f = createFixture('lifecycle');
  try {
    const targets = resolveGlobalTargets({homeDir: f.homeDir});

    // Pre-populate unrelated user configuration to verify byte-for-byte preservation across install/uninstall
    mkdirSync(resolve(f.homeDir, '.codex'), {recursive: true});
    const unrelatedCodexToml = [
      '# Custom developer Codex config',
      '[general]',
      'default_model = "gpt-5"',
      '',
      '[custom_plugin]',
      'enabled = true',
      ''
    ].join('\n');
    writeFileSync(targets.codexConfig, unrelatedCodexToml, 'utf8');

    mkdirSync(resolve(f.homeDir, '.gemini/config'), {recursive: true});
    const unrelatedHooks = {
      'custom-developer-hook': {
        SessionStart: [
          {
            type: 'command',
            command: 'echo custom-hook',
            timeout: 3
          }
        ]
      }
    };
    writeFileSync(targets.geminiHooks, JSON.stringify(unrelatedHooks, null, 2) + '\n', 'utf8');

    // 1. Requirement 1: Injected isolated home install
    const installResult = installGlobalBridge({
      homeDir: f.homeDir,
      stateDirectory: f.stateDirectory
    });
    assert.equal(installResult.status, 'INSTALLED');

    // Verify global config has no pinned root or local workspace files (--workspace or cwd in ~/.codex/config.toml)
    const installedToml = readFileSync(targets.codexConfig, 'utf8');
    assert.ok(installedToml.includes(CODEX_MCP_BEGIN_MARKER));
    assert.ok(installedToml.includes(CODEX_MCP_END_MARKER));
    assert.equal(installedToml.includes('--workspace'), false);
    assert.equal(installedToml.includes('cwd'), false);
    assert.equal(installedToml.includes(f.rootA), false);
    assert.equal(installedToml.includes(f.rootB), false);
    assert.ok(installedToml.startsWith(unrelatedCodexToml));

    // Verify no project-specific files written into non-onboarded project roots
    assert.deepEqual(readdirSync(f.rootA), ['README.md']);
    assert.deepEqual(readdirSync(f.rootB), ['README.md']);

    // Verify global assets created in user home
    assert.ok(existsSync(targets.orchestratorSkill));
    assert.ok(existsSync(targets.workerSkill));
    assert.ok(existsSync(targets.sidecarManifest));
    assert.ok(existsSync(targets.geminiHooks));

    const installedHooks = JSON.parse(readFileSync(targets.geminiHooks, 'utf8'));
    assert.ok(Object.hasOwn(installedHooks, HOOK_KEY));
    assert.ok(Object.hasOwn(installedHooks, 'custom-developer-hook'));

    // 2. Requirement 2: Two non-onboarded roots handled independently via per-call workspace_root without collision
    const call = createLiveToolHandler({stateDirectory: f.stateDirectory});

    await assert.rejects(call('bridge_status', {}), /WORKSPACE_CONTEXT_REQUIRED/);

    const statusA = await call('bridge_status', {workspace_root: f.rootA});
    const statusB = await call('bridge_status', {workspace_root: f.rootB});

    assert.notEqual(statusA.project_id, statusB.project_id);
    assert.equal(statusA.workspace_root, canonicalWorkspace(f.rootA));
    assert.equal(statusB.workspace_root, canonicalWorkspace(f.rootB));
    assert.equal(statusA.workspace_context.source, 'session_context_argument');
    assert.equal(statusB.workspace_context.source, 'session_context_argument');
    assert.equal(statusA.workspace_context.host_attested, false);
    assert.equal(statusB.workspace_context.host_attested, false);
    assert.deepEqual(readdirSync(f.rootA), ['README.md']);
    assert.deepEqual(readdirSync(f.rootB), ['README.md']);
    assert.equal(listLiveWorkspaces({stateDirectory: f.stateDirectory}).length, 2);

    // 3. Requirement 3: End-to-end flow on root A (mocked sidecar transport & worker report -> fresh parent verify)
    processBeaconInput(
      {
        conversationId: 'chat-session-root-a',
        workspacePaths: [f.rootA]
      },
      {stateDirectory: f.stateDirectory}
    );

    const statusAAfterBeacon = await call('bridge_status', {workspace_root: f.rootA});
    assert.equal(statusAAfterBeacon.active_gui_target.conversation_id, 'chat-session-root-a');

    const jobA = await call('submit_job', {
      workspace_root: f.rootA,
      request: 'Inspect Project A README and verify independent structure',
      read_scope: ['README.md'],
      write_scope: [],
      acceptance_criteria: ['Audit accurate'],
      verification_commands: ['noop']
    });
    assert.equal(jobA.state, 'PENDING');
    assert.equal(jobA.target_conversation_id, 'chat-session-root-a');

    const sidecarCallsA = [];
    const tickResultA = await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      env: {
        ANTIGRAVITY_AGENTAPI_EXE: process.execPath,
        ANTIGRAVITY_LS_ADDRESS: 'local-bridge-test'
      },
      invokeAgentapi: async (argv) => {
        sidecarCallsA.push(argv);
        return mockSuccessfulTransport();
      }
    });

    assert.equal(sidecarCallsA.length, 1);
    assert.equal(sidecarCallsA[0][0], 'send-message');
    assert.equal(sidecarCallsA[0][1], 'chat-session-root-a');
    assert.ok(tickResultA.actions.some(a => a.action === 'DISPATCHED' && a.task_id === jobA.task_id));

    submitWorkerReport({
      briefPath: jobA.brief_json_path,
      summary: 'Verified Project A README',
      inspected: ['README.md'],
      evidence: ['README.md:1'],
      stateDirectory: f.stateDirectory
    });

    // 4. Requirement 4: Receiver selection only from actual mocked transport with parent VERIFIED receipt
    const verifiedA = await call('verify_job', {
      workspace_root: f.rootA,
      task_id: jobA.task_id,
      accepted: true,
      select_receiver: true,
      review_notes: ['Parent verified audit and marked receiver selected']
    });
    assert.equal(verifiedA.verified, true);
    assert.equal(verifiedA.state, 'VERIFIED');
    assert.equal(verifiedA.functional_tests, 'NOT_RUN');
    assert.deepEqual(verifiedA.actual_changed_files, []);

    const selectedRec = readSelectedReceiver({stateDirectory: f.stateDirectory});
    assert.equal(selectedRec.enabled, true);
    assert.equal(selectedRec.conversation_id, 'chat-session-root-a');
    assert.equal(selectedRec.verified_task_id, jobA.task_id);
    assert.equal(selectedRec.proves_gui_focus, false);

    // 5. Requirement 6: Strict routing check (explicit use_selected_receiver: false in bridge_status retains strict workspace gate)
    const strictB = await call('bridge_status', {
      workspace_root: f.rootB,
      use_selected_receiver: false
    });
    assert.ok(strictB.reason_codes.includes('TARGET_MISSING'));
    assert.equal(strictB.ready_to_dispatch, false);
    assert.equal(strictB.active_gui_target, null);

    // 6. Requirement 5: Dispatch root B via chosen receiver without claiming matching Beacon or GUI focus
    const statusBSelected = await call('bridge_status', {workspace_root: f.rootB});
    assert.equal(statusBSelected.ready_to_dispatch, true);
    assert.equal(statusBSelected.delivery_target.mode, 'user_selected_receiver');
    assert.equal(statusBSelected.delivery_target.proves_gui_focus, false);
    assert.equal(statusBSelected.active_gui_target, null);

    const jobB = await call('submit_job', {
      workspace_root: f.rootB,
      request: 'Inspect Project B README',
      read_scope: ['README.md'],
      write_scope: [],
      acceptance_criteria: ['README B verified'],
      verification_commands: ['noop']
    });
    assert.equal(jobB.state, 'PENDING');
    assert.equal(jobB.delivery_target.mode, 'user_selected_receiver');
    assert.equal(jobB.target_conversation_id, 'chat-session-root-a');

    // Confirm cross-root task isolation
    await assert.rejects(
      call('get_job_status', {workspace_root: f.rootA, task_id: jobB.task_id}),
      /not found|ENOENT/i
    );
    const statusJobB = await call('get_job_status', {workspace_root: f.rootB, task_id: jobB.task_id});
    assert.equal(statusJobB.task_id, jobB.task_id);

    const sidecarCallsB = [];
    const tickResultB = await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      invokeAgentapi: async (argv) => {
        sidecarCallsB.push(argv);
        return mockSuccessfulTransport();
      }
    });

    assert.equal(sidecarCallsB.length, 1);
    assert.equal(sidecarCallsB[0][0], 'send-message');
    assert.equal(sidecarCallsB[0][1], 'chat-session-root-a');
    assert.ok(tickResultB.actions.some(a => a.action === 'DISPATCHED' && a.task_id === jobB.task_id));

    submitWorkerReport({
      briefPath: jobB.brief_json_path,
      summary: 'Verified Project B README',
      inspected: ['README.md'],
      evidence: ['README.md:1'],
      stateDirectory: f.stateDirectory
    });

    const verifiedB = await call('verify_job', {
      workspace_root: f.rootB,
      task_id: jobB.task_id,
      accepted: true
    });
    assert.equal(verifiedB.verified, true);
    assert.equal(verifiedB.state, 'VERIFIED');
    assert.deepEqual(readdirSync(f.rootA), ['README.md']);
    assert.deepEqual(readdirSync(f.rootB), ['README.md']);

    // 7. Requirement 8: Uninstall reverts only owned additions and preserves unrelated user config / preexisting state
    const unResult = uninstallGlobalBridge({
      homeDir: f.homeDir,
      stateDirectory: f.stateDirectory
    });
    assert.equal(unResult.status, 'UNINSTALLED');

    const afterToml = readFileSync(targets.codexConfig, 'utf8');
    assert.equal(afterToml.includes(CODEX_MCP_BEGIN_MARKER), false);
    assert.equal(afterToml.includes(CODEX_MCP_END_MARKER), false);
    assert.equal(afterToml, unrelatedCodexToml);

    const afterHooks = JSON.parse(readFileSync(targets.geminiHooks, 'utf8'));
    assert.equal(Object.hasOwn(afterHooks, HOOK_KEY), false);
    assert.ok(Object.hasOwn(afterHooks, 'custom-developer-hook'));

    assert.equal(existsSync(targets.workerSkill), false);
    assert.equal(existsSync(targets.orchestratorSkill), false);
    assert.equal(existsSync(targets.sidecarManifest), false);

    assert.deepEqual(readdirSync(f.rootA), ['README.md']);
    assert.deepEqual(readdirSync(f.rootB), ['README.md']);
  } finally {
    f.cleanup();
  }
});

test('tamper rejection: tampered bound delivery routes and unverified receiver selection fail closed and refuse dispatch', async () => {
  const f = createFixture('tamper-rejection');
  try {
    installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDirectory});
    const call = createLiveToolHandler({stateDirectory: f.stateDirectory});

    // 1. Unverified receiver selection must fail closed
    assert.throws(
      () => selectVerifiedReceiver({state: 'PENDING'}, {stateDirectory: f.stateDirectory}),
      /Receiver selection requires an actually delivered, parent-VERIFIED job/
    );

    assert.throws(
      () => selectVerifiedReceiver(
        {state: 'RESULT_READY', outcome: null, host_receipt: null},
        {stateDirectory: f.stateDirectory}
      ),
      /Receiver selection requires an actually delivered, parent-VERIFIED job/
    );

    assert.throws(
      () => selectVerifiedReceiver(
        {
          state: 'VERIFIED',
          outcome: null,
          host_receipt: {accepted: false},
          delivery: {kind: 'ANTIGRAVITY_AGENTAPI', started: true, exit_code: 0, target_conversation_id: 'chat-ok'}
        },
        {stateDirectory: f.stateDirectory}
      ),
      /Receiver selection requires an actually delivered, parent-VERIFIED job/
    );

    assert.throws(
      () => selectVerifiedReceiver(
        {
          state: 'VERIFIED',
          outcome: null,
          host_receipt: {accepted: true},
          delivery: {kind: 'ANTIGRAVITY_AGENTAPI', started: false, exit_code: 1, target_conversation_id: 'chat-ok'}
        },
        {stateDirectory: f.stateDirectory}
      ),
      /Receiver selection requires an actually delivered, parent-VERIFIED job/
    );

    assert.throws(
      () => selectVerifiedReceiver(
        {
          state: 'VERIFIED',
          outcome: null,
          host_receipt: {accepted: true},
          delivery: {kind: 'MANUAL', started: true, exit_code: 0, target_conversation_id: 'chat-ok'}
        },
        {stateDirectory: f.stateDirectory}
      ),
      /Receiver selection requires an actually delivered, parent-VERIFIED job/
    );

    // Calling verify_job with select_receiver on a pending job via MCP must reject
    processBeaconInput({conversationId: 'chat-tamper-test', workspacePaths: [f.rootA]}, {stateDirectory: f.stateDirectory});
    const jobA = await call('submit_job', {
      workspace_root: f.rootA,
      request: 'Pending job check',
      read_scope: ['README.md'],
      write_scope: [],
      acceptance_criteria: ['Check'],
      verification_commands: ['noop']
    });

    await assert.rejects(
      call('verify_job', {workspace_root: f.rootA, task_id: jobA.task_id, accepted: true, select_receiver: true}),
      /wait for RESULT_READY before verify_job/
    );
    assert.equal(readSelectedReceiver({stateDirectory: f.stateDirectory}), null);

    // Complete job A successfully to obtain a verified receiver
    await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      env: {ANTIGRAVITY_AGENTAPI_EXE: process.execPath, ANTIGRAVITY_LS_ADDRESS: 'local-bridge-test'},
      invokeAgentapi: async () => mockSuccessfulTransport()
    });

    submitWorkerReport({
      briefPath: jobA.brief_json_path,
      summary: 'Legitimate report for job A',
      inspected: ['README.md'],
      evidence: ['README.md:1'],
      stateDirectory: f.stateDirectory
    });

    await call('verify_job', {
      workspace_root: f.rootA,
      task_id: jobA.task_id,
      accepted: true,
      select_receiver: true
    });

    assert.ok(readSelectedReceiver({stateDirectory: f.stateDirectory}));

    // 2. Tampered bound delivery route must fail closed and refuse dispatch
    const jobB = await call('submit_job', {
      workspace_root: f.rootB,
      request: 'Job B with bound delivery route',
      read_scope: ['README.md'],
      write_scope: [],
      acceptance_criteria: ['Audit'],
      verification_commands: ['noop']
    });

    const {inbox: inboxB} = openLiveInbox(f.rootB, {stateDirectory: f.stateDirectory});
    const routeRel = `delivery-targets/${jobB.task_id}-${jobB.attempt_id}.json`;
    const routeFile = scopedPath(inboxB.root, routeRel);
    assert.ok(existsSync(routeFile));

    const legitimateRoute = JSON.parse(readFileSync(routeFile, 'utf8'));

    // Tamper Scenario A: Mismatched job_sha256
    const tamperedHashRoute = {...legitimateRoute, job_sha256: sha256('tampered-job-content')};
    writeFileSync(routeFile, JSON.stringify(tamperedHashRoute, null, 2), 'utf8');

    assert.throws(
      () => readJobReceiver(inboxB, jobB),
      /Invalid bound delivery target/
    );

    let agentapiInvocations = 0;
    const tickTamperedHash = await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      invokeAgentapi: async () => {
        agentapiInvocations++;
        return mockSuccessfulTransport();
      }
    });

    assert.equal(agentapiInvocations, 0, 'Sidecar must refuse dispatch when job_sha256 is tampered');
    const hashAction = tickTamperedHash.actions.find(a => a.task_id === jobB.task_id);
    assert.equal(hashAction.action, 'INVALID_DELIVERY_TARGET');
    assert.match(hashAction.error, /Invalid bound delivery target/);

    const jobRecordAfterHashTamper = inboxB.get(jobB.task_id);
    assert.equal(jobRecordAfterHashTamper.state, 'PENDING');
    assert.equal(jobRecordAfterHashTamper.outcome, null);

    // Tamper Scenario B: Mismatched task_id
    const tamperedTaskIdRoute = {...legitimateRoute, task_id: randomUUID()};
    writeFileSync(routeFile, JSON.stringify(tamperedTaskIdRoute, null, 2), 'utf8');

    assert.throws(
      () => readJobReceiver(inboxB, jobB),
      /Invalid bound delivery target/
    );

    const tickTamperedTaskId = await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      invokeAgentapi: async () => {
        agentapiInvocations++;
        return mockSuccessfulTransport();
      }
    });

    assert.equal(agentapiInvocations, 0, 'Sidecar must refuse dispatch when task_id is tampered');
    const taskIdAction = tickTamperedTaskId.actions.find(a => a.task_id === jobB.task_id);
    assert.equal(taskIdAction.action, 'INVALID_DELIVERY_TARGET');

    // Tamper Scenario C: Malformed selection conversation_id
    const tamperedSelectionRoute = {
      ...legitimateRoute,
      selection: {...legitimateRoute.selection, conversation_id: 'spaces are forbidden in id!'}
    };
    writeFileSync(routeFile, JSON.stringify(tamperedSelectionRoute, null, 2), 'utf8');

    assert.throws(
      () => readJobReceiver(inboxB, jobB),
      /Invalid bound delivery target/
    );

    const tickTamperedSelection = await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      invokeAgentapi: async () => {
        agentapiInvocations++;
        return mockSuccessfulTransport();
      }
    });

    assert.equal(agentapiInvocations, 0, 'Sidecar must refuse dispatch when selection is invalid');
    const selectionAction = tickTamperedSelection.actions.find(a => a.task_id === jobB.task_id);
    assert.equal(selectionAction.action, 'INVALID_DELIVERY_TARGET');
  } finally {
    f.cleanup();
  }
});

test('explicit use_selected_receiver=false in submit_job disables receiver routing and prevents dispatch without matching beacon', async () => {
  const f = createFixture('strict-optout');
  try {
    installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDirectory});
    const call = createLiveToolHandler({stateDirectory: f.stateDirectory});

    processBeaconInput({conversationId: 'chat-verified-root-a', workspacePaths: [f.rootA]}, {stateDirectory: f.stateDirectory});
    const jobA = await call('submit_job', {
      workspace_root: f.rootA,
      request: 'Seed receiver',
      read_scope: ['README.md'],
      write_scope: [],
      acceptance_criteria: ['Audit'],
      verification_commands: ['noop']
    });

    await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      env: {ANTIGRAVITY_AGENTAPI_EXE: process.execPath, ANTIGRAVITY_LS_ADDRESS: 'local-bridge-test'},
      invokeAgentapi: async () => mockSuccessfulTransport()
    });

    submitWorkerReport({
      briefPath: jobA.brief_json_path,
      summary: 'Report A',
      inspected: ['README.md'],
      evidence: ['README.md:1'],
      stateDirectory: f.stateDirectory
    });

    await call('verify_job', {
      workspace_root: f.rootA,
      task_id: jobA.task_id,
      accepted: true,
      select_receiver: true
    });

    assert.ok(readSelectedReceiver({stateDirectory: f.stateDirectory}));

    // Submit job on root B with explicit use_selected_receiver: false
    const jobBStrict = await call('submit_job', {
      workspace_root: f.rootB,
      request: 'Strict job on B without selected receiver',
      read_scope: ['README.md'],
      write_scope: [],
      acceptance_criteria: ['Audit'],
      verification_commands: ['noop'],
      use_selected_receiver: false
    });

    assert.equal(jobBStrict.delivery_target.mode, 'matching_workspace');
    assert.equal(jobBStrict.target_conversation_id, null);
    assert.ok(jobBStrict.reason_codes.includes('TARGET_MISSING'));

    const {inbox: inboxB} = openLiveInbox(f.rootB, {stateDirectory: f.stateDirectory});
    assert.equal(readJobReceiver(inboxB, jobBStrict), null);

    let invocations = 0;
    const tick = await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      invokeAgentapi: async () => {
        invocations++;
        return mockSuccessfulTransport();
      }
    });

    assert.equal(invocations, 0, 'Sidecar must not dispatch when strict workspace gate has no beacon');
    const waitingAction = tick.actions.find(a => a.task_id === jobBStrict.task_id);
    assert.equal(waitingAction.action, 'WAITING_FOR_GUI_SESSION');
    assert.ok(waitingAction.reason_codes.includes('TARGET_MISSING'));
  } finally {
    f.cleanup();
  }
});

// Shared setup: job A verified with select_receiver, then a bound job B on root B.
async function boundJobOnRootB(f) {
  installGlobalBridge({homeDir: f.homeDir, stateDirectory: f.stateDirectory});
  const call = createLiveToolHandler({stateDirectory: f.stateDirectory});
  processBeaconInput({conversationId: 'chat-route-test', workspacePaths: [f.rootA]}, {stateDirectory: f.stateDirectory});
  const base = {read_scope: ['README.md'], write_scope: [], acceptance_criteria: ['Audit'], verification_commands: ['noop']};
  const jobA = await call('submit_job', {...base, workspace_root: f.rootA, request: 'Seed receiver'});
  await runLiveSidecarTick({
    stateDirectory: f.stateDirectory,
    env: {ANTIGRAVITY_AGENTAPI_EXE: process.execPath, ANTIGRAVITY_LS_ADDRESS: 'local-bridge-test'},
    invokeAgentapi: async () => mockSuccessfulTransport()
  });
  submitWorkerReport({briefPath: jobA.brief_json_path, summary: 'Report A', inspected: ['README.md'], evidence: ['README.md:1'], stateDirectory: f.stateDirectory});
  await call('verify_job', {workspace_root: f.rootA, task_id: jobA.task_id, accepted: true, select_receiver: true});
  const jobB = await call('submit_job', {...base, workspace_root: f.rootB, request: 'Bound job B'});
  const {inbox} = openLiveInbox(f.rootB, {stateDirectory: f.stateDirectory});
  const routeFile = scopedPath(inbox.root, `delivery-targets/${jobB.task_id}-${jobB.attempt_id}.json`);
  return {call, jobB, job: inbox.get(jobB.task_id).job, inbox, routeFile, route: JSON.parse(readFileSync(routeFile, 'utf8'))};
}

async function assertRefusedAndPending(f, ctx, label) {
  assert.throws(() => readJobReceiver(ctx.inbox, ctx.job), /Invalid bound delivery target/, label);
  let invocations = 0;
  const tick = await runLiveSidecarTick({
    stateDirectory: f.stateDirectory,
    invokeAgentapi: async () => { invocations++; return mockSuccessfulTransport(); }
  });
  assert.equal(invocations, 0, `${label}: zero transport`);
  assert.equal(tick.actions.find(a => a.task_id === ctx.jobB.task_id).action, 'INVALID_DELIVERY_TARGET', label);
  assert.equal(ctx.inbox.get(ctx.jobB.task_id).state, 'PENDING', label);
}

test('new versioned route envelope: valid-looking changed conversation ID or missing proof is rejected before transport', async () => {
  const f = createFixture('route-v2');
  try {
    const ctx = await boundJobOnRootB(f);
    assert.equal(ctx.route.format, 'desktop-inbox.delivery-target@2');
    assert.match(ctx.route.selection_sha256, /^[a-f0-9]{64}$/);
    assert.equal(readJobReceiver(ctx.inbox, ctx.job).conversation_id, 'chat-route-test');

    // A syntactically valid but different conversation ID, checksum left unchanged.
    const changed = {...ctx.route, selection: {...ctx.route.selection, conversation_id: 'other-valid-chat'}};
    writeFileSync(ctx.routeFile, JSON.stringify(changed, null, 2), 'utf8');
    await assertRefusedAndPending(f, ctx, 'changed conversation id');

    // Missing proof fields, and a removed checksum.
    for (const field of ['host_receipt_sha256', 'verified_task_id', 'verified_attempt_id', 'selected_at', 'enabled']) {
      const selection = {...ctx.route.selection};
      delete selection[field];
      writeFileSync(ctx.routeFile, JSON.stringify({...ctx.route, selection, selection_sha256: sha256(selection)}, null, 2), 'utf8');
      await assertRefusedAndPending(f, ctx, `missing ${field}`);
    }
    const noChecksum = {...ctx.route};
    delete noChecksum.selection_sha256;
    writeFileSync(ctx.routeFile, JSON.stringify(noChecksum, null, 2), 'utf8');
    await assertRefusedAndPending(f, ctx, 'missing checksum');

    // Restoring the original envelope makes it readable again.
    writeFileSync(ctx.routeFile, JSON.stringify(ctx.route, null, 2), 'utf8');
    assert.equal(readJobReceiver(ctx.inbox, ctx.job).conversation_id, 'chat-route-test');
  } finally {
    f.cleanup();
  }
});

test('existing version-1 routes remain readable and dispatch to the bound receiver', async () => {
  const f = createFixture('route-v1');
  try {
    const ctx = await boundJobOnRootB(f);
    const v1 = {
      format: 'desktop-inbox.delivery-target@1',
      task_id: ctx.route.task_id,
      attempt_id: ctx.route.attempt_id,
      job_sha256: ctx.route.job_sha256,
      selection: ctx.route.selection
    };
    writeFileSync(ctx.routeFile, JSON.stringify(v1, null, 2), 'utf8');
    assert.equal(readJobReceiver(ctx.inbox, ctx.job).conversation_id, 'chat-route-test');

    const calls = [];
    await runLiveSidecarTick({
      stateDirectory: f.stateDirectory,
      invokeAgentapi: async args => { calls.push(args); return mockSuccessfulTransport(); }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'chat-route-test');
  } finally {
    f.cleanup();
  }
});
