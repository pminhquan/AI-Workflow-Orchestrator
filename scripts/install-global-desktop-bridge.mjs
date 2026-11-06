import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import os from 'node:os';
import {ROOT} from '../src/core/util.mjs';
import {
  inspectGlobalBridgeStatus,
  planGlobalBridgeInstall,
  installGlobalBridge,
  uninstallGlobalBridge,
  buildCodexGlobalTomlBlock,
  buildGlobalHookEntry,
  buildCanonicalSidecarManifest
} from '../src/desktop-inbox/global-install.mjs';

export {
  inspectGlobalBridgeStatus,
  planGlobalBridgeInstall,
  installGlobalBridge,
  uninstallGlobalBridge,
  buildCodexGlobalTomlBlock,
  buildGlobalHookEntry,
  buildCanonicalSidecarManifest
};

export function parseCliArgs(args = process.argv.slice(2)) {
  let mode = null; // 'install' | 'uninstall' | 'status'
  let dryRun = false;
  let homeDir = undefined;
  let stateDirectory = undefined;
  let nodePath = undefined;
  let rootDir = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--install') {
      if (mode && mode !== 'install') throw Error('Conflicting operation modes specified');
      mode = 'install';
    } else if (arg === '--uninstall') {
      if (mode && mode !== 'uninstall') throw Error('Conflicting operation modes specified');
      mode = 'uninstall';
    } else if (arg === '--status') {
      if (mode && mode !== 'status') throw Error('Conflicting operation modes specified');
      mode = 'status';
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--home' && args[i + 1]) {
      homeDir = args[++i];
    } else if (arg === '--state' && args[i + 1]) {
      stateDirectory = args[++i];
    } else if (arg === '--node' && args[i + 1]) {
      nodePath = args[++i];
    } else if (arg === '--root' && args[i + 1]) {
      rootDir = args[++i];
    } else {
      throw Error(
        `Unknown or incomplete argument: ${arg}\n` +
        `Usage: node scripts/install-global-desktop-bridge.mjs [--install | --uninstall | --status] [--dry-run]`
      );
    }
  }

  if (!mode) {
    if (dryRun) {
      mode = 'install';
    } else {
      throw Error(
        'Missing required action.\n' +
        'Usage: node scripts/install-global-desktop-bridge.mjs [--install | --uninstall | --status] [--dry-run]'
      );
    }
  }

  return {mode, dryRun, homeDir, stateDirectory, nodePath, rootDir};
}

export function main(args = process.argv.slice(2)) {
  const options = parseCliArgs(args);
  const opts = {
    ...(options.homeDir !== undefined ? {homeDir: options.homeDir} : {}),
    ...(options.stateDirectory !== undefined ? {stateDirectory: options.stateDirectory} : {}),
    ...(options.nodePath !== undefined ? {nodePath: options.nodePath} : {}),
    ...(options.rootDir !== undefined ? {rootDir: options.rootDir} : {}),
    dryRun: options.dryRun
  };

  let result;
  if (options.mode === 'status') {
    result = inspectGlobalBridgeStatus(opts);
  } else if (options.mode === 'install') {
    result = installGlobalBridge(opts);
  } else if (options.mode === 'uninstall') {
    result = uninstallGlobalBridge(opts);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(JSON.stringify({status: 'ERROR', message: error.message}) + '\n');
    process.exitCode = 1;
  }
}
