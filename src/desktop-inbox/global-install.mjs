import {randomUUID} from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  lstatSync,
  unlinkSync,
  renameSync,
  rmdirSync
  ,openSync,closeSync,fsyncSync,linkSync
} from 'node:fs';
import {dirname, resolve, basename, isAbsolute} from 'node:path';
import os from 'node:os';
import {ROOT, sha256,inside} from '../core/util.mjs';

export const CODEX_MCP_BEGIN_MARKER = '# BEGIN AWO DESKTOP BRIDGE';
export const CODEX_MCP_END_MARKER = '# END AWO DESKTOP BRIDGE';
export const HOOK_KEY = 'awo-desktop-bridge-beacon';
export const SIDECAR_DIR_NAME = 'awo-bridge';
export const ORCHESTRATOR_SKILL_NAME = 'antigravity-orchestrator';
export const WORKER_SKILL_NAME = 'codex-worker';
export const LIVE_DISCOVERY_NOT_VERIFIED = 'NOT VERIFIED';
export const GUIDANCE_BEGIN='<!-- awo-global-workflow:start -->';
export const GUIDANCE_END='<!-- awo-global-workflow:end -->';
export function buildGlobalGuidanceBlock(){return [GUIDANCE_BEGIN,'## Global coding workflow','For substantive coding, web/app development and debugging in the CURRENT Codex workspace, use the user-global antigravity-orchestrator skill and desktop_inbox MCP automatically. The user already selects the workspace, conversation, model and reasoning in Antigravity GUI; never ask for task/conversation IDs or wait for the user to prompt you to divide work/spawn subagents.','Fast 2-step loop: (1) automatically decompose multi-part work into parallel wave subtasks (disjoint write_scope) and call submit_job({ workspace_root, request, subtasks, replace_active: true }) so Sidecar injects the prompt (with an auto-generated Surgical Symbol & Line Map) directly into the open Antigravity chat and submits it; (2) call wait_job({ workspace_root, auto_verify: true }) without task_id and read ONLY concise_summary (findings, changed_files, tests, errors) — do not re-read modified files from start to finish unless debugging a reported error or blocker.','Surgical & token discipline: read files by line range using symbol maps/rg -n rather than full-file reads, cap noisy shell/test output, and make minimal diffs without boilerplate.',GUIDANCE_END].join('\n');}

function extractGuidance(content){const start=content.indexOf(GUIDANCE_BEGIN),end=content.indexOf(GUIDANCE_END,start);return start<0||end<0?null:content.slice(start,end+GUIDANCE_END.length);}
const isManagedText=id=>id==='codex_mcp'||id==='codex_guidance';

const DESKTOP_INBOX_SECTION_REGEX = /\[\s*["']?mcp_servers["']?\s*\.\s*["']?desktop_inbox["']?\s*\]/i;

export function verifyPathSafety(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw Error('Invalid path: path must be a non-empty string');
  }
  const resolved = resolve(targetPath);
  let current = resolved;
  const segments = [];
  while (current && dirname(current) !== current) {
    segments.unshift(current);
    current = dirname(current);
  }
  for (const seg of segments) {
    {
      const stat = lstatSync(seg,{throwIfNoEntry:false});
      if(!stat)continue;
      if (stat.isSymbolicLink()) {
        throw Error(`Symlinks/junctions rejected in path: ${seg}`);
      }
    }
  }
  return resolved;
}

export function atomicWriteText(path, text,{exclusive=false}={}) {
  verifyPathSafety(path);
  mkdirSync(dirname(path), {recursive: true});
  const tempPath = path + '.tmp-' + randomUUID();
  let fd;
  try{
    fd=openSync(tempPath,'wx');writeFileSync(fd,text,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;
    if(exclusive){linkSync(tempPath,path);unlinkSync(tempPath);}else renameSync(tempPath, path);
  }finally{if(fd!==undefined)closeSync(fd);if(existsSync(tempPath))unlinkSync(tempPath);}
}

export function atomicWriteJSON(path, value) {
  return atomicWriteText(path, JSON.stringify(value, null, 2) + '\n');
}

export function resolveGlobalTargets({ homeDir = os.homedir() } = {}) {
  const resolvedHome = verifyPathSafety(resolve(homeDir));
  return {
    homeDir: resolvedHome,
    codexConfig: resolve(resolvedHome, '.codex/config.toml'),
    codexGuidance: resolve(resolvedHome, '.codex/AGENTS.md'),
    orchestratorSkill: resolve(resolvedHome, '.agents/skills', ORCHESTRATOR_SKILL_NAME, 'SKILL.md'),
    geminiHooks: resolve(resolvedHome, '.gemini/config/hooks.json'),
    workerSkill: resolve(resolvedHome, '.gemini/config/skills', WORKER_SKILL_NAME, 'SKILL.md'),
    sidecarManifest: resolve(resolvedHome, '.gemini/config/sidecars', SIDECAR_DIR_NAME, 'sidecar.json'),
    sidecarsDir: resolve(resolvedHome, '.gemini/config/sidecars')
  };
}

export function resolveCanonicalSources({ rootDir = ROOT } = {}) {
  const resolvedRoot = verifyPathSafety(resolve(rootDir));
  return {
    rootDir: resolvedRoot,
    orchestratorSkill: resolve(resolvedRoot, '.agents/skills', ORCHESTRATOR_SKILL_NAME, 'SKILL.md'),
    workerSkill: resolve(resolvedRoot, '.agents/skills', WORKER_SKILL_NAME, 'SKILL.md'),
    liveMcpServer: resolve(resolvedRoot, 'src/desktop-inbox/live-mcp-server.mjs'),
    hookBeacon: resolve(resolvedRoot, 'src/desktop-inbox/hook-beacon.mjs'),
    liveSidecar: resolve(resolvedRoot, 'src/desktop-inbox/live-sidecar.mjs')
  };
}

export function buildCodexGlobalTomlBlock({ nodePath = process.execPath, rootDir = ROOT } = {}) {
  const sources = resolveCanonicalSources({ rootDir });
  return [
    CODEX_MCP_BEGIN_MARKER,
    '[mcp_servers.desktop_inbox]',
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(sources.liveMcpServer)}]`,
    'enabled = true',
    'enabled_tools = ["bridge_status", "submit_job", "wait_job", "get_job_status", "get_job_result", "verify_job", "release_job"]',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 120',
    CODEX_MCP_END_MARKER
  ].join('\n');
}

export function buildGlobalHookEntry({ nodePath = process.execPath, rootDir = ROOT } = {}) {
  const sources = resolveCanonicalSources({ rootDir });
  return {
    enabled: true,
    SessionStart: [
      {
        type: 'command',
        command: `"${nodePath}" "${sources.hookBeacon}" SessionStart`,
        timeout: 5
      }
    ],
    PreInvocation: [
      {
        type: 'command',
        command: `"${nodePath}" "${sources.hookBeacon}" PreInvocation`,
        timeout: 5
      }
    ],
    PostInvocation: [
      {
        type: 'command',
        command: `"${nodePath}" "${sources.hookBeacon}" PostInvocation`,
        timeout: 5
      }
    ],
    Stop: [
      {
        type: 'command',
        command: `"${nodePath}" "${sources.hookBeacon}" Stop`,
        timeout: 5
      }
    ]
  };
}

export function buildCanonicalSidecarManifest({ nodePath = process.execPath, rootDir = ROOT } = {}) {
  const sources = resolveCanonicalSources({ rootDir });
  return {
    command: nodePath,
    args: [sources.liveSidecar],
    restart_policy: 'always',
    display_name: 'AWO Desktop Bridge',
    description: 'Live mailbox sidecar delivering Codex Boss jobs directly into the active Antigravity Desktop GUI conversation.'
  };
}

export function extractMarkedTomlBlock(content) {
  if (typeof content !== 'string') return null;
  const beginIdx = content.indexOf(CODEX_MCP_BEGIN_MARKER);
  if (beginIdx === -1) return null;
  const endIdx = content.indexOf(CODEX_MCP_END_MARKER, beginIdx);
  if (endIdx === -1) return null;
  return content.slice(beginIdx, endIdx + CODEX_MCP_END_MARKER.length);
}

export function removeMarkedTomlBlock(content, installedBlock = null) {
  const block = installedBlock || extractMarkedTomlBlock(content);
  if (!block) return content;
  const target = block;

  // Prefer removing with exact preceding single newline
  const patternWithPrefix = '\n' + target + '\n';
  const idxPrefix = content.indexOf(patternWithPrefix);
  if (idxPrefix !== -1) {
    return content.slice(0, idxPrefix) + content.slice(idxPrefix + patternWithPrefix.length);
  }

  const idxExact = content.indexOf(target + '\n');
  if (idxExact !== -1) {
    return content.slice(0, idxExact) + content.slice(idxExact + target.length + 1);
  }

  return content.replace(target, '');
}

export function findExistingLiveSidecars({ sidecarsDir, liveSidecarScript }) {
  if (!existsSync(sidecarsDir)) return [];
  const normalizedTarget = liveSidecarScript.toLowerCase().replaceAll('\\', '/');
  const matches = [];
  try {
    const entries = readdirSync(sidecarsDir, { withFileTypes: true });
    for (const entry of entries) {
      if(entry.name==='codex-bridge')continue;
      if(entry.isSymbolicLink())throw Error('Symlink/junction Sidecar directory rejected');
      if (!entry.isDirectory()) continue;
      if (entry.name === 'codex-bridge') continue; // Do not touch legacy codex-bridge
      const manifestPath = resolve(sidecarsDir, entry.name, 'sidecar.json');
      verifyPathSafety(manifestPath);
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (Array.isArray(manifest?.args)) {
          const pointsToScript = manifest.args.some(arg => {
            if (typeof arg !== 'string') return false;
            return arg.toLowerCase().replaceAll('\\', '/') === normalizedTarget;
          });
          if (pointsToScript) {
            matches.push({
              dirName: entry.name,
              path: manifestPath,
              manifest
            });
          }
        }
      } catch {
        // Skip unparseable manifests
      }
    }
  } catch(error) {throw Error('Cannot inspect Sidecar registrations: '+error.message);}
  return matches;
}

export function resolveStateDir({ rootDir = ROOT, stateDirectory } = {}) {
  let statePath;
  if (stateDirectory) {
    statePath = resolve(rootDir, stateDirectory);
  } else {
    statePath = resolve(rootDir, 'state/desktop-inbox-live/global-install');
  }
  if(!inside(resolve(rootDir,'state'),statePath)||statePath===resolve(rootDir,'state'))throw Error('Installation receipts must stay under canonical ignored state/');
  return verifyPathSafety(statePath);
}

function preflightPaths(targets,sources,stateDir){
  const directories=[targets.homeDir,stateDir];
  const files=[targets.codexConfig,targets.codexGuidance,targets.orchestratorSkill,targets.geminiHooks,targets.workerSkill,targets.sidecarManifest,resolve(stateDir,'receipt.json')];
  for(const path of [...directories,...files,...Object.values(sources)]){
    verifyPathSafety(path);
    let ancestor=dirname(path);
    while(dirname(ancestor)!==ancestor){
      const stat=lstatSync(ancestor,{throwIfNoEntry:false});
      if(stat&&!stat.isDirectory())throw Error('Non-directory config ancestor: '+ancestor);
      ancestor=dirname(ancestor);
    }
  }
  for(const path of directories){const stat=lstatSync(path,{throwIfNoEntry:false});if(stat&&!stat.isDirectory())throw Error('Expected directory: '+path);}
  for(const path of files){const stat=lstatSync(path,{throwIfNoEntry:false});if(stat&&!stat.isFile())throw Error('Expected regular config file: '+path);}
  for(const [name,path] of Object.entries(sources)){
    const stat=lstatSync(path,{throwIfNoEntry:false});
    if(!stat||(name==='rootDir'?!stat.isDirectory():!stat.isFile()))throw Error('Invalid canonical source: '+name);
  }
}

export function validatePlainObject(value, pathLabel) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(`Invalid JSON format at ${pathLabel}: expected a plain JSON object`);
  }
}

export function buildRollbackCommand({ nodePath, rootDir, homeDir, stateDirectory }) {
  const cliScript = resolve(rootDir, 'scripts/install-global-desktop-bridge.mjs');
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const parts = [quote(nodePath),quote(cliScript),'--uninstall'];
  if (homeDir) parts.push('--home',quote(homeDir));
  if (stateDirectory) parts.push('--state',quote(stateDirectory));
  if (rootDir) parts.push('--root',quote(rootDir));
  if (nodePath) parts.push('--node',quote(nodePath));
  return '& '+parts.join(' ');
}

export function inspectGlobalBridgeStatus({
  homeDir = os.homedir(),
  rootDir = ROOT,
  nodePath = process.execPath,
  stateDirectory
} = {}) {
  const targets = resolveGlobalTargets({ homeDir });
  const sources = resolveCanonicalSources({ rootDir });
  const stateDir = resolveStateDir({ rootDir, stateDirectory });
  preflightPaths(targets,sources,stateDir);
  const expectedTomlBlock = buildCodexGlobalTomlBlock({ nodePath, rootDir });
  const expectedHook = buildGlobalHookEntry({ nodePath, rootDir });

  // 1. Codex MCP config
  let codexStatus = {
    path: targets.codexConfig,
    present: existsSync(targets.codexConfig),
    installed: false,
    collision: false,
    drift: false,
    details: 'File not present'
  };
  if (codexStatus.present) {
    const tomlContent = readFileSync(targets.codexConfig, 'utf8');
    const markedBlock = extractMarkedTomlBlock(tomlContent);
    if (markedBlock) {
      if (markedBlock === expectedTomlBlock) {
        // Also check if there is an unowned desktop_inbox table outside the marked block
        const outside = tomlContent.replace(markedBlock, '');
        if (DESKTOP_INBOX_SECTION_REGEX.test(outside)) {
          codexStatus.collision = true;
          codexStatus.details = 'Unowned [mcp_servers.desktop_inbox] section present outside managed block';
        } else {
          codexStatus.installed = true;
          codexStatus.details = 'Matching managed block present';
        }
      } else {
        codexStatus.drift = true;
        codexStatus.details = 'Managed block content differs from expected';
      }
    } else if (DESKTOP_INBOX_SECTION_REGEX.test(tomlContent)) {
      codexStatus.collision = true;
      codexStatus.details = 'Unowned [mcp_servers.desktop_inbox] section present without managed markers';
    } else {
      codexStatus.details = 'Present without desktop_inbox section';
    }
  }

  // 2. Orchestrator Skill
  let orchestratorStatus = {
    path: targets.orchestratorSkill,
    present: existsSync(targets.orchestratorSkill),
    installed: false,
    collision: false,
    details: 'File not present'
  };
  if (orchestratorStatus.present) {
    const content = readFileSync(targets.orchestratorSkill, 'utf8');
    const canonical = existsSync(sources.orchestratorSkill) ? readFileSync(sources.orchestratorSkill, 'utf8') : '';
    if (canonical && content === canonical) {
      orchestratorStatus.installed = true;
      orchestratorStatus.details = 'Matching canonical skill present';
    } else {
      orchestratorStatus.collision = true;
      orchestratorStatus.details = 'Skill content differs from canonical template';
    }
  }

  // 3. Gemini hooks.json
  let hooksStatus = {
    path: targets.geminiHooks,
    present: existsSync(targets.geminiHooks),
    installed: false,
    collision: false,
    drift: false,
    details: 'File not present'
  };
  if (hooksStatus.present) {
    try {
      const hooksObj = JSON.parse(readFileSync(targets.geminiHooks, 'utf8'));
      validatePlainObject(hooksObj, targets.geminiHooks);
      if (Object.hasOwn(hooksObj, HOOK_KEY)) {
        const currentEntry = hooksObj[HOOK_KEY];
        if (JSON.stringify(currentEntry) === JSON.stringify(expectedHook)) {
          hooksStatus.installed = true;
          hooksStatus.details = `Matching owned hook "${HOOK_KEY}" present`;
        } else {
          hooksStatus.drift = true;
          hooksStatus.details = `Owned hook "${HOOK_KEY}" content differs from expected`;
        }
      } else {
        hooksStatus.details = `Present without "${HOOK_KEY}" hook`;
      }
    } catch (e) {
      hooksStatus.collision = true;
      hooksStatus.details = `Invalid JSON or non-object in hooks file: ${e.message}`;
    }
  }

  // 4. Codex Worker Skill
  let workerStatus = {
    path: targets.workerSkill,
    present: existsSync(targets.workerSkill),
    installed: false,
    collision: false,
    details: 'File not present'
  };
  if (workerStatus.present) {
    const content = readFileSync(targets.workerSkill, 'utf8');
    const canonical = existsSync(sources.workerSkill) ? readFileSync(sources.workerSkill, 'utf8') : '';
    if (canonical && content === canonical) {
      workerStatus.installed = true;
      workerStatus.details = 'Matching canonical skill present';
    } else {
      workerStatus.collision = true;
      workerStatus.details = 'Skill content differs from canonical template';
    }
  }

  // 5. Sidecar registration
  let sidecarStatus = {
    path: targets.sidecarManifest,
    present: existsSync(targets.sidecarManifest),
    installed: false,
    collision: false,
    drift: false,
    reused: false,
    duplicate_count: 0,
    details: 'File not present'
  };
  const matchingSidecars = findExistingLiveSidecars({
    sidecarsDir: targets.sidecarsDir,
    liveSidecarScript: sources.liveSidecar
  });
  if (matchingSidecars.length > 1) {
    sidecarStatus.collision = true;
    sidecarStatus.duplicate_count = matchingSidecars.length;
    sidecarStatus.details = `Duplicate sidecar registrations found for live-sidecar.mjs in: ${matchingSidecars.map(m => m.dirName).join(', ')}`;
  } else if (matchingSidecars.length === 1) {
    const existing = matchingSidecars[0];
    sidecarStatus.present = true;
    sidecarStatus.installed = true;
    sidecarStatus.reused = true;
    sidecarStatus.path = existing.path;
    sidecarStatus.details = `Reused existing registration under ${existing.dirName}/sidecar.json byte-for-byte`;
  } else if (sidecarStatus.present) {
    sidecarStatus.collision = true;
    sidecarStatus.details = 'Existing sidecar at awo-bridge/sidecar.json points to a different script';
  }

  // Receipt check
  const receiptPath = resolve(stateDir, 'receipt.json');
  let receipt = null;
  if (existsSync(receiptPath)) {
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch {}
  }

  const guidanceStatus={path:targets.codexGuidance,present:existsSync(targets.codexGuidance),installed:false,collision:false,drift:false};
  if(guidanceStatus.present){
    const content=readFileSync(targets.codexGuidance,'utf8'),section=extractGuidance(content);
    if(section)guidanceStatus.installed=section===buildGlobalGuidanceBlock();
    if((content.includes(GUIDANCE_BEGIN)||content.includes(GUIDANCE_END))&&!guidanceStatus.installed)guidanceStatus.drift=true;
  }
  const targetList = [codexStatus,guidanceStatus, orchestratorStatus, hooksStatus, workerStatus, sidecarStatus];
  const hasCollision = targetList.some(t => t.collision);
  const hasDrift = targetList.some(t => t.drift);
  const allInstalled = targetList.every(t => t.installed);
  const noneInstalled = targetList.every(t => !t.installed && !t.present);

  let overallStatus = 'PARTIAL';
  if (hasCollision) overallStatus = 'COLLISION';
  else if (hasDrift) overallStatus = 'DRIFT';
  else if (allInstalled) overallStatus = 'INSTALLED';
  else if (noneInstalled) overallStatus = 'NOT_INSTALLED';

  return {
    installation_status: overallStatus,
    live_discovery: LIVE_DISCOVERY_NOT_VERIFIED,
    live_discovery_note: 'Live agent runtime discovery and Sidecar process state require active host session and runtime verification.',
    targets: {
      codex_mcp: codexStatus,
      codex_guidance: guidanceStatus,
      orchestrator_skill: orchestratorStatus,
      gemini_hooks: hooksStatus,
      worker_skill: workerStatus,
      sidecar_manifest: sidecarStatus
    },
    receipt
  };
}

export function planGlobalBridgeInstall({
  homeDir = os.homedir(),
  rootDir = ROOT,
  nodePath = process.execPath,
  stateDirectory
} = {}) {
  const status = inspectGlobalBridgeStatus({homeDir, rootDir, nodePath, stateDirectory});
  const targets = resolveGlobalTargets({homeDir});
  const sources = resolveCanonicalSources({rootDir});
  const expectedTomlBlock = buildCodexGlobalTomlBlock({nodePath, rootDir});
  const expectedHook = buildGlobalHookEntry({nodePath, rootDir});
  const expectedSidecar = buildCanonicalSidecarManifest({nodePath, rootDir});

  // Preflight collision / drift checks
  const collisions = [];
  for (const [key, t] of Object.entries(status.targets)) {
    if (t.collision) {
      collisions.push({target: key, path: t.path, reason: t.details});
    } else if (t.drift) {
      collisions.push({target: key, path: t.path, reason: `Owned content drift: ${t.details}`});
    }
  }
  if (collisions.length > 0) {
    throw Error(
      `Installation preflight failed with collisions/drift:\n` +
      collisions.map(c => `  - [${c.target}] ${c.path}: ${c.reason}`).join('\n')
    );
  }

  // Preflight check plain object shape for existing hooks.json
  if (existsSync(targets.geminiHooks)) {
    const raw = readFileSync(targets.geminiHooks, 'utf8');
    validatePlainObject(JSON.parse(raw), targets.geminiHooks);
  }

  // Ensure source files exist
  for (const [name, path] of Object.entries(sources)) {
    if (!existsSync(path)) {
      throw Error(`Missing canonical source dependency: ${name} at ${path}`);
    }
  }

  const actions = [];

  // 1. Codex config
  if (!status.targets.codex_mcp.installed) {
    actions.push({
      id: 'codex_mcp',
      path: targets.codexConfig,
      action: status.targets.codex_mcp.present ? 'merge_block' : 'create_file',
      existed_before: status.targets.codex_mcp.present,
      reused: false,
      block: expectedTomlBlock
    });
  } else {
    actions.push({
      id: 'codex_mcp',
      path: targets.codexConfig,
      action: 'reused',
      existed_before: true,
      reused: true,
      block: expectedTomlBlock
    });
  }

  // 2. Orchestrator skill
  if (!status.targets.orchestrator_skill.installed) {
    actions.push({
      id: 'orchestrator_skill',
      path: targets.orchestratorSkill,
      action: 'create_file',
      existed_before: false,
      reused: false,
      source: sources.orchestratorSkill
    });
  } else {
    actions.push({
      id: 'orchestrator_skill',
      path: targets.orchestratorSkill,
      action: 'reused',
      existed_before: true,
      reused: true,
      source: sources.orchestratorSkill
    });
  }

  // 3. Gemini hooks
  if (!status.targets.gemini_hooks.installed) {
    actions.push({
      id: 'gemini_hooks',
      path: targets.geminiHooks,
      action: status.targets.gemini_hooks.present ? 'merge_key' : 'create_file',
      existed_before: status.targets.gemini_hooks.present,
      reused: false,
      key: HOOK_KEY,
      entry: expectedHook
    });
  } else {
    actions.push({
      id: 'gemini_hooks',
      path: targets.geminiHooks,
      action: 'reused',
      existed_before: true,
      reused: true,
      key: HOOK_KEY,
      entry: expectedHook
    });
  }

  // 4. Worker skill
  if (!status.targets.worker_skill.installed) {
    actions.push({
      id: 'worker_skill',
      path: targets.workerSkill,
      action: 'create_file',
      existed_before: false,
      reused: false,
      source: sources.workerSkill
    });
  } else {
    actions.push({
      id: 'worker_skill',
      path: targets.workerSkill,
      action: 'reused',
      existed_before: true,
      reused: true,
      source: sources.workerSkill
    });
  }

  // 5. Sidecar manifest
  if (!status.targets.sidecar_manifest.installed) {
    actions.push({
      id: 'sidecar_manifest',
      path: targets.sidecarManifest,
      action: 'create_file',
      existed_before: false,
      reused: false,
      manifest: expectedSidecar
    });
  } else {
    actions.push({
      id: 'sidecar_manifest',
      path: status.targets.sidecar_manifest.path,
      action: 'reused',
      existed_before: true,
      reused: true,
      manifest: expectedSidecar
    });
  }

  const guidance=status.targets.codex_guidance;
  actions.push({id:'codex_guidance',path:targets.codexGuidance,action:guidance.installed?'reused':guidance.present?'merge_block':'create_file',existed_before:guidance.present,reused:guidance.installed,block:buildGlobalGuidanceBlock()});
  const mutatingActions = actions.filter(a => !a.reused);

  return {
    status: status.installation_status,
    actions_needed: mutatingActions.length,
    actions
  };
}

export function installGlobalBridge({
  homeDir = os.homedir(),
  rootDir = ROOT,
  nodePath = process.execPath,
  stateDirectory,
  dryRun = false,
  failAfterAction = null,
  failAfterWrite = null
} = {}) {
  const plan = planGlobalBridgeInstall({homeDir, rootDir, nodePath, stateDirectory});
  const targets = resolveGlobalTargets({homeDir});
  const sources = resolveCanonicalSources({rootDir});
  const stateDir = resolveStateDir({rootDir, stateDirectory});

  const existingReceiptPath=resolve(stateDir,'receipt.json');
  if(existsSync(existingReceiptPath)&&!dryRun){
    const existing=JSON.parse(readFileSync(existingReceiptPath,'utf8'));
    if(existing.status==='IN_PROGRESS')throw Error('Interrupted installation: use the recorded --uninstall rollback before installing again');
  }

  if (plan.actions_needed === 0) {
    return {
      status: 'ALREADY_INSTALLED',
      dry_run: dryRun,
      actions: [],
      ready_hint: 'Global desktop bridge is already installed and matches canonical definitions.'
    };
  }

  if (dryRun) {
    return {
      status: 'DRY_RUN',
      dry_run: true,
      actions_planned: plan.actions.filter(a => !a.reused).map(a => ({id: a.id, action: a.action, path: a.path}))
    };
  }

  const receiptPath = resolve(stateDir,'receipt.json');
  if(existsSync(receiptPath)){
    const previous=JSON.parse(readFileSync(receiptPath,'utf8'));
    if(previous.target_home!==targets.homeDir||previous.root_dir!==sources.rootDir)throw Error('Existing receipt belongs to another installation target');
    if(previous.status!=='UNINSTALLED')throw Error('Existing installation receipt must be reviewed or uninstalled before applying changes');
    const history=resolve(stateDir,'history',randomUUID()+'.json');
    atomicWriteJSON(history,previous);
  }

  const backupDir = resolve(stateDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  const backups = [];
  const plannedTargetEntries = [];
  const contents=new Map();

  // Prepare backups and initial hashes BEFORE any mutation
  for (const item of plan.actions) {
    let beforeHash = null;
    let backupPath = null;
    let addedSlice = null;

    if (existsSync(item.path)) {
      const existingBytes = readFileSync(item.path);
      beforeHash = sha256(existingBytes);
      if (!item.reused) {
        mkdirSync(backupDir, {recursive: true});
        backupPath = resolve(backupDir, basename(item.path) + '.' + beforeHash.slice(0, 8) + '.bak');
        copyFileSync(item.path, backupPath);
        backups.push({target_path: item.path, backup_path: backupPath, hash: beforeHash});

        if (isManagedText(item.id)) {
          const cur = readFileSync(item.path, 'utf8');
          let prefix = '';
          if (cur.endsWith('\n\n')) {
            prefix = '';
          } else if (cur.endsWith('\n')) {
            prefix = '\n';
          } else {
            prefix = '\n\n';
          }
          addedSlice = prefix + item.block + '\n';
        }
      }
    } else if (isManagedText(item.id)) {
      addedSlice = item.block + '\n';
    }

    let content=null;
    if(!item.reused){
      const before=existsSync(item.path)?new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(item.path)):'';
      if(isManagedText(item.id))content=before+addedSlice;
      else if(item.id==='gemini_hooks'){const merged=before?JSON.parse(before):{};merged[item.key]=item.entry;content=JSON.stringify(merged,null,2)+'\n';}
      else if(item.source)content=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(item.source));
      else content=JSON.stringify(item.manifest,null,2)+'\n';
      contents.set(item.id,content);
    }
    plannedTargetEntries.push({
      id: item.id,
      path: item.path,
      action: item.action,
      existed_before: item.existed_before,
      reused: item.reused,
      before_hash: beforeHash,
      after_hash: content===null?beforeHash:sha256(content),
      backup_path: backupPath,
      installed_block: isManagedText(item.id) ? item.block : null,
      added_slice: addedSlice,
      installed_entry: item.id === 'gemini_hooks' ? item.entry : null
    });
  }

  const rollbackCommand = buildRollbackCommand({
    nodePath,
    rootDir: sources.rootDir,
    homeDir: targets.homeDir,
    stateDirectory
  });

  // 1. Write durable receipt in IN_PROGRESS state BEFORE first mutation
  const receipt = {
    schema_version: 'desktop-inbox.global-install-receipt@1',
    installed_at: new Date().toISOString(),
    target_home: targets.homeDir,
    root_dir: sources.rootDir,
    node_path: nodePath,
    status: 'IN_PROGRESS',
    completed_targets: [],
    targets: plannedTargetEntries,
    backups,
    rollback_command: rollbackCommand
  };

  mkdirSync(stateDir, {recursive: true});
  atomicWriteJSON(receiptPath, receipt);

  // 2. Perform mutations sequentially, updating receipt progress per action
  const executedActions = [];
  const mutatingItems = plan.actions.filter(a => !a.reused);

  let mutationIndex = 0;
  for (const item of mutatingItems) {
    mutationIndex++;
    const targetEntry=plannedTargetEntries.find(entry=>entry.id===item.id);
    verifyPathSafety(item.path);
    const currentHash=existsSync(item.path)?sha256(readFileSync(item.path)):null;
    if(currentHash!==targetEntry.before_hash)throw Error('Concurrent modification detected in '+item.path);
    atomicWriteText(item.path,contents.get(item.id),{exclusive:!item.existed_before});
    executedActions.push(targetEntry);
    if(failAfterWrite===mutationIndex)throw Error('Simulated interruption after config write before receipt progress');

    // Update progress per action
    receipt.completed_targets.push(item.id);
    atomicWriteJSON(receiptPath, receipt);

    // Test failure hook for testing interruption recovery
    if (failAfterAction !== null && mutationIndex === failAfterAction) {
      throw Error(`Simulated installation failure after action ${mutationIndex} (${item.id})`);
    }
  }

  // 3. Mark receipt status as INSTALLED
  receipt.status = 'INSTALLED';
  atomicWriteJSON(receiptPath, receipt);

  return {
    status: 'INSTALLED',
    dry_run: false,
    actions: executedActions,
    receipt_path: receiptPath,
    rollback_command: receipt.rollback_command
  };
}

export function uninstallGlobalBridge({
  homeDir = os.homedir(),
  rootDir = ROOT,
  nodePath = process.execPath,
  stateDirectory,
  dryRun = false
} = {}) {
  const targets = resolveGlobalTargets({homeDir});
  const sources = resolveCanonicalSources({rootDir});
  const stateDir = resolveStateDir({rootDir, stateDirectory});
  preflightPaths(targets,sources,stateDir);
  const receiptPath = resolve(stateDir, 'receipt.json');

  if (!existsSync(receiptPath)) {
    throw Error(
      `Cannot uninstall: missing durable installation receipt at ${receiptPath}. ` +
      `Matching content without installation ownership is insufficient.`
    );
  }

  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  validatePlainObject(receipt, receiptPath);

  // Validate that receipt is bound to exact home + canonical root
  if (resolve(receipt.target_home) !== targets.homeDir) {
    throw Error(
      `Uninstall receipt home mismatch: receipt is bound to "${receipt.target_home}", but current target home is "${targets.homeDir}"`
    );
  }
  if (resolve(receipt.root_dir) !== sources.rootDir) {
    throw Error(
      `Uninstall receipt root mismatch: receipt is bound to "${receipt.root_dir}", but current root is "${sources.rootDir}"`
    );
  }
  if(receipt.status==='UNINSTALLED')return {status:'ALREADY_UNINSTALLED',dry_run:dryRun,actions:[]};
  if(receipt.schema_version!=='desktop-inbox.global-install-receipt@1'||!Array.isArray(receipt.targets))throw Error('Invalid installation receipt');
  const allowed={codex_mcp:targets.codexConfig,codex_guidance:targets.codexGuidance,gemini_hooks:targets.geminiHooks,orchestrator_skill:targets.orchestratorSkill,worker_skill:targets.workerSkill,sidecar_manifest:targets.sidecarManifest};
  const ids=new Set();
  for(const entry of receipt.targets){
    if(ids.has(entry.id)||!Object.hasOwn(allowed,entry.id))throw Error('Invalid receipt target identity');
    ids.add(entry.id);
    if(entry.reused)continue;
    if(entry.path!==allowed[entry.id])throw Error('Receipt target path mismatch');
    verifyPathSafety(entry.path);
    if(!/^[a-f0-9]{64}$/.test(entry.after_hash??''))throw Error('Receipt lacks planned after hash');
  }

  // Determine which actions were performed according to receipt
  const targetsToRollback = [];
  const completedIds = Array.isArray(receipt.completed_targets)
    ? receipt.completed_targets
    : (receipt.status === 'INSTALLED' ? receipt.targets.filter(t => !t.reused).map(t => t.id) : []);

  for (const t of receipt.targets) {
    // Pre-existing unmanaged assets must NEVER be deleted during rollback
    if (t.existed_before === true && t.reused === true) continue;
    if(t.reused)continue;
    if(!completedIds.includes(t.id)){
      if(!existsSync(t.path))continue;
      const current=readFileSync(t.path),hash=sha256(current);
      if(hash===t.before_hash)continue;
      if(isManagedText(t.id)&&!(t.id==='codex_mcp'?extractMarkedTomlBlock(current.toString('utf8')):extractGuidance(current.toString('utf8'))))continue;
      if(t.id==='gemini_hooks'&&!Object.hasOwn(JSON.parse(current.toString('utf8')),HOOK_KEY))continue;
      // A crash can occur after atomic rename and before progress is saved.
      // The pre-written hash and owned inverse still identify that write.
    }
    targetsToRollback.push(t);
  }

  // Drift protection: compare against installed content recorded in receipt
  const drifts = [];
  for (const item of targetsToRollback) {
    if (!existsSync(item.path)) continue;

    if (isManagedText(item.id)) {
      const cur = readFileSync(item.path, 'utf8');
      const marked = item.id==='codex_mcp'?extractMarkedTomlBlock(cur):extractGuidance(cur);
      if (!marked) {
        drifts.push({target: item.id, path: item.path, reason: 'Managed TOML block missing'});
      } else if (marked !== item.installed_block) {
        drifts.push({target: item.id, path: item.path, reason: 'Managed TOML block has drifted from recorded receipt'});
      }
    } else if (item.id === 'gemini_hooks') {
      try {
        const cur = JSON.parse(readFileSync(item.path, 'utf8'));
        validatePlainObject(cur, item.path);
        if (!Object.hasOwn(cur, HOOK_KEY)) {
          drifts.push({target: item.id, path: item.path, reason: `Owned hook key "${HOOK_KEY}" missing`});
        } else if (JSON.stringify(cur[HOOK_KEY]) !== JSON.stringify(item.installed_entry)) {
          drifts.push({target: item.id, path: item.path, reason: `Owned hook "${HOOK_KEY}" has drifted from recorded receipt`});
        }
      } catch (e) {
        drifts.push({target: item.id, path: item.path, reason: `Hooks file unparseable: ${e.message}`});
      }
    } else if (item.id === 'orchestrator_skill' || item.id === 'worker_skill') {
      const cur = readFileSync(item.path, 'utf8');
      if (item.after_hash && sha256(cur) !== item.after_hash) {
        drifts.push({target: item.id, path: item.path, reason: 'Skill file content has drifted from recorded receipt'});
      }
    } else if (item.id === 'sidecar_manifest') {
      const cur = readFileSync(item.path, 'utf8');
      if (item.after_hash && sha256(cur) !== item.after_hash) {
        drifts.push({target: item.id, path: item.path, reason: 'Sidecar manifest content has drifted from recorded receipt'});
      }
    }
  }

  if (drifts.length > 0) {
    throw Error(
      `Uninstall aborted: drift detected in owned content; preserving user edits:\n` +
      drifts.map(d => `  - [${d.target}] ${d.path}: ${d.reason}`).join('\n')
    );
  }

  if (dryRun) {
    return {
      status: 'DRY_RUN',
      dry_run: true,
      actions_planned: targetsToRollback.map(t => ({id: t.id, path: t.path, action: 'revert'}))
    };
  }

  const executed = [];

  for (const item of targetsToRollback) {
    if (!existsSync(item.path)) continue;

    if (isManagedText(item.id)) {
      const cur = readFileSync(item.path, 'utf8');
      let next;
      if (item.added_slice && cur.includes(item.added_slice)) {
        const idx = cur.indexOf(item.added_slice);
        next = cur.slice(0, idx) + cur.slice(idx + item.added_slice.length);
      } else {
        next = item.id==='codex_mcp'?removeMarkedTomlBlock(cur, item.installed_block):cur.replace(item.installed_block,'');
      }
      if (!next.trim() && !item.existed_before) {
        unlinkSync(item.path);
        executed.push({id: item.id, path: item.path, action: 'deleted_empty_file'});
      } else {
        atomicWriteText(item.path, next);
        executed.push({id: item.id, path: item.path, action: 'reverted_marked_block'});
      }
    } else if (item.id === 'gemini_hooks') {
      const cur = readFileSync(item.path, 'utf8');
      const hooksObj = JSON.parse(cur);
      delete hooksObj[HOOK_KEY];
      if (Object.keys(hooksObj).length === 0 && !item.existed_before) {
        unlinkSync(item.path);
        executed.push({id: item.id, path: item.path, action: 'deleted_empty_file'});
      } else {
        atomicWriteText(item.path, JSON.stringify(hooksObj, null, 2) + '\n');
        executed.push({id: item.id, path: item.path, action: 'reverted_json_key'});
      }
    } else if (item.id === 'orchestrator_skill' || item.id === 'worker_skill') {
      unlinkSync(item.path);
      executed.push({id: item.id, path: item.path, action: 'deleted_skill_file'});
    } else if (item.id === 'sidecar_manifest') {
      unlinkSync(item.path);
      try {
        const sidecarDir = dirname(item.path);
        if (readdirSync(sidecarDir).length === 0) {
          rmdirSync(sidecarDir);
        }
      } catch {}
      executed.push({id: item.id, path: item.path, action: 'deleted_sidecar_manifest'});
    }
  }

  // Update receipt with uninstalled state (keep historical evidence and backups)
  receipt.status = 'UNINSTALLED';
  receipt.uninstalled_at = new Date().toISOString();
  receipt.rollback_actions = executed;
  atomicWriteJSON(receiptPath, receipt);

  return {
    status: 'UNINSTALLED',
    dry_run: false,
    actions: executed
  };
}
