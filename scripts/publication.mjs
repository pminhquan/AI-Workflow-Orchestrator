import {existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, realpathSync, renameSync, unlinkSync, rmdirSync} from 'node:fs';
import {resolve, relative, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {sha256, scopedPath, inside, safeRelative} from '../src/core/util.mjs';
import {assertPublicationSafe} from './publication-security.mjs';

export const MANIFEST = 'PUBLICATION-MANIFEST.json';
const KIND = 'sanitized-publication@1';
const ROOT = resolve(import.meta.dirname, '..');
const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')));
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function parseJSON(content, label) {
  try { return JSON.parse(content.toString('utf8')); }
  catch { throw Error('Invalid JSON in ' + label); }
}
function git(root, args) {
  const result = spawnSync('git', args, {cwd: root, windowsHide: true, shell: false, maxBuffer: 32 * 1024 * 1024});
  if (result.status !== 0) throw Error('Read-only Git operation failed: ' + args[0]);
  return result.stdout;
}
const PUBLICATION_NOTE = `# Sanitized foundation review snapshot

Canonical source → sanitized export → private GitHub review. Edit the canonical project only; this directory is disposable publication output.

Source implementation and test files are copied byte for byte. The deployment manifest intentionally has no installed machine targets or private baseline hashes. Two private legacy JSON snapshots are omitted. Machine-specific audit documents are replaced with omission notices; README checkout paths are placeholders. See PUBLICATION-MANIFEST.json for projections and exact output hashes.

Run node src/cli.mjs test and node src/cli.mjs validate. The V1 checksum test and node src/cli.mjs verify-v1 cannot validate a live installation from this snapshot: the private V1 baseline is deliberately absent. Report that failure; never insert an empty or synthetic passing baseline. Other tests still run. Historical acceptance documents describe the original foundation, not a new verification of this snapshot.

No original .git directory, author email, private runtime state or V1 settings are exported. No integration has been activated. package.json retains its existing license declaration; upstream attribution and pinned research are preserved.

Update and pre-push procedure: docs/operations/private-publication.md.
`;
const OMITTED_AUDIT = `# Private machine audit omitted from publication

The canonical project retains the original machine audit. This publication snapshot omits its local paths, runtime mapping and historical machine-specific report. It is not evidence of a live V1 installation or unchanged live configuration.

Read ../../PUBLICATION.md for omissions and test limitations, ../architecture/overview.md for the foundation design, and ../research/upstream-evaluation.md for upstream attribution. Do not reconstruct a private baseline or substitute a fabricated passing verification.
`;

function projectFile(file, input, mode, root) {
  if (mode === 'copy') return input;
  if (mode === 'publication-attributes') return Buffer.concat([input, Buffer.from('\n# Publication commits preserve exact verified bytes across platforms.\n* -text\n')]);
  if (mode === 'readme-checkout') {
    let text = input.toString('utf8');
    for (const form of [root, root.replaceAll('\\', '/'), root.replaceAll('\\', '\\\\')]) text = text.split(form).join('<REVIEW_CHECKOUT>');
    return Buffer.from(text);
  }
  if (mode === 'omit-machine-audit') return Buffer.from(OMITTED_AUDIT);
  if (mode === 'deployment-projection') {
    const manifest = parseJSON(input, file);
    if (!Array.isArray(manifest.components) || manifest.activation !== 'foundation-only') throw Error('Unexpected deployment manifest structure');
    for (const component of manifest.components) {
      component.installed_target_path = null;
      if (component.management !== 'staged') {
        component.canonical_source_path = null;
        component.content_hash = null;
      }
    }
    return json(manifest);
  }
  throw Error('Unrecognized projection for ' + file);
}

export function buildPlan({root, policy, inventory, commit}) {
  root = realpathSync(root);
  if (policy.schema_version !== '1' || !Array.isArray(policy.include) || !Array.isArray(policy.optional) || !policy.exclude || !policy.projections) throw Error('Invalid publication policy');
  const declared = [...policy.include, ...policy.optional, ...Object.keys(policy.exclude)];
  declared.forEach(safeRelative);
  if (new Set(declared).size !== declared.length) throw Error('Duplicate publication classification');
  for (const [file, mode] of Object.entries(policy.projections)) {
    if (!policy.include.includes(file) || !['readme-checkout', 'omit-machine-audit', 'deployment-projection', 'publication-attributes'].includes(mode)) throw Error('Invalid projection declaration');
    if (file.startsWith('src/') || file.startsWith('tests/') || file.startsWith('agents/generated/')) throw Error('Implementation, tests and generated profiles must remain byte-identical');
    const allowed = {'README.md': 'readme-checkout', '.gitattributes': 'publication-attributes', 'config/deployment/components.json': 'deployment-projection', 'docs/audit/final-report.md': 'omit-machine-audit', 'docs/audit/v1-inventory.md': 'omit-machine-audit'};
    if (allowed[file] !== mode) throw Error('Projection is not approved for this path');
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid canonical commit identifier');
  const unknown = [...new Set(inventory)].filter(file => !declared.includes(file));
  if (unknown.length) { const error = Error('Unclassified canonical files block export'); error.paths = unknown.sort(); throw error; }
  for (const file of policy.include) if (!inventory.includes(file)) throw Error('Required publication input absent from Git inventory: ' + file);
  const files = Object.create(null), inputs = Object.create(null), modes = Object.create(null);
  for (const file of [...policy.include, ...policy.optional.filter(file => inventory.includes(file))].sort()) {
    const inputPath = scopedPath(root, file);
    if (!lstatSync(inputPath).isFile()) throw Error('Publication input is not a regular file: ' + file);
    const input = readFileSync(inputPath), mode = policy.projections[file] || 'copy';
    // Scan before projection as well: redaction must never silently hide a credential.
    assertPublicationSafe({[file]: input}, {machineMetadata: mode !== 'copy'});
    files[file] = projectFile(file, input, mode, root);
    inputs[file] = sha256(input);
    modes[file] = mode;
  }
  if (Object.hasOwn(files, MANIFEST) || Object.hasOwn(files, 'PUBLICATION.md')) throw Error('Reserved publication output name');
  files['PUBLICATION.md'] = Buffer.from(PUBLICATION_NOTE);
  assertPublicationSafe(files);
  const inputFingerprint = sha256(sorted(inputs));
  const manifest = {
    kind: KIND,
    canonical_base_commit: commit,
    source_state: 'captured-working-tree; base commit is provenance, not a claim of a clean worktree',
    input_fingerprint: inputFingerprint,
    files: sorted(Object.fromEntries(Object.entries(files).map(([file, content]) => [file, sha256(content)]))),
    projections: sorted(Object.fromEntries(Object.entries(modes).filter(([, mode]) => mode !== 'copy'))),
    excluded: sorted(policy.exclude),
    original_history_exported: false,
  };
  files[MANIFEST] = json(manifest);
  assertPublicationSafe({[MANIFEST]: files[MANIFEST]});
  return {files: sorted(files), inputs: sorted(inputs), inputFingerprint, manifest};
}

export function publicationInventory(root) {
  const visible = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  // An ignored JSONL fixture or source file must not silently vanish from review.
  // Root runtime/cache directories remain excluded; source-area exceptions need
  // an explicit policy classification even when Git ignores their extension.
  const sourceArea = /^(?:src|tests|agents|config|workflows|docs|scripts|benchmarks)\//;
  return [...new Set([...visible, ...ignored.filter(file => sourceArea.test(file))])].sort();
}
export function planCanonical(root = ROOT) {
  root = realpathSync(root);
  const gitRoot = git(root, ['rev-parse', '--show-toplevel']).toString().trim();
  if (realpathSync(gitRoot) !== root) throw Error('Run against the canonical repository root, not a parent checkout');
  const policyPath = scopedPath(root, 'config/publication/allowlist.json');
  const policy = parseJSON(readFileSync(policyPath), 'publication policy');
  const inventory = publicationInventory(root);
  const commit = git(root, ['rev-parse', 'HEAD']).toString().trim();
  return buildPlan({root, policy, inventory, commit});
}

function listOutput(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const absolute = resolve(dir, entry.name), file = relative(root, absolute).split(sep).join('/');
      if (file === '.git') {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('Linked Git directories/worktrees are not publication output');
        continue;
      }
      if (entry.isSymbolicLink()) throw Error('Publication output contains a link');
      if (entry.isDirectory()) visit(scopedPath(root, file));
      else if (entry.isFile()) files.push(file);
      else throw Error('Publication output contains a non-regular file');
    }
  }
  visit(root);
  return files.sort();
}

// Once a publication repository is initialized in a later approved task, keep
// only its own clean publication history. This function is read-only.
export function verifyPublicationHistory(destination) {
  if (!existsSync(resolve(destination, '.git'))) return {commits: 0, status: 'NO_GIT_HISTORY'};
  const commits = git(destination, ['rev-list', '--branches', '--tags']).toString().trim().split(/\r?\n/).filter(Boolean);
  for (const commit of commits) {
    const metadata = git(destination, ['cat-file', 'commit', commit]).toString();
    const identities = metadata.split('\n').filter(line => /^(?:author|committer) /.test(line));
    if (identities.length !== 2 || identities.some(line => !/<\d+\+[A-Za-z0-9-]+@users\.noreply\.github\.com> \d+ [+-]\d{4}$/.test(line))) throw Error('Publication history requires GitHub ID+login noreply identities');
    const historicalManifest = parseJSON(git(destination, ['show', commit + ':' + MANIFEST]), 'historical publication manifest');
    if (historicalManifest.kind !== KIND || historicalManifest.original_history_exported !== false) throw Error('Non-publication Git history rejected');
    const historicalFiles = Object.create(null);
    const paths = git(destination, ['ls-tree', '-rz', '--full-tree', commit]).toString().split('\0').filter(Boolean);
    for (const entry of paths) {
      const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/);
      if (!match) throw Error('Links/submodules in publication history rejected');
      const [, , oid, file] = match; safeRelative(file);
      if (file !== MANIFEST && !Object.hasOwn(historicalManifest.files, file)) throw Error('Unclassified path in publication history');
      const content = git(destination, ['cat-file', 'blob', oid]);
      if (file !== MANIFEST && sha256(content) !== historicalManifest.files[file]) throw Error('Publication history fingerprint mismatch');
      historicalFiles[file] = content;
    }
    if (Object.keys(historicalFiles).length !== Object.keys(historicalManifest.files).length + 1) throw Error('Missing classified file in publication history');
    assertPublicationSafe(historicalFiles);
    assertPublicationSafe({'commit-message.txt': Buffer.from(metadata.slice(metadata.indexOf('\n\n') + 2))});
  }
  return {commits: commits.length, status: 'OFFLINE-TESTED'};
}

function assertDestination(destination, canonicalRoot) {
  destination = resolve(destination); canonicalRoot = realpathSync(canonicalRoot);
  if (inside(destination, canonicalRoot) || inside(canonicalRoot, destination)) throw Error('Use a separate publication directory outside the canonical repository');
  let ancestor = destination;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (lstatSync(ancestor).isSymbolicLink() || realpathSync(ancestor).toLowerCase() !== ancestor.toLowerCase()) throw Error('Destination ancestors must not contain links');
  return destination;
}
function assertOwned(destination) {
  if (!existsSync(destination)) return null;
  if (!lstatSync(destination).isDirectory()) throw Error('Destination is not a directory');
  const actual = listOutput(destination);
  if (!actual.length && !existsSync(resolve(destination, '.git'))) return null;
  if (!actual.includes(MANIFEST)) throw Error('Refusing to overwrite an unmanaged directory');
  const old = parseJSON(readFileSync(scopedPath(destination, MANIFEST)), 'destination ownership manifest');
  if (old.kind !== KIND || old.original_history_exported !== false || !old.files || typeof old.files !== 'object') throw Error('Invalid destination ownership manifest');
  Object.keys(old.files).forEach(safeRelative);
  if (JSON.stringify(actual) !== JSON.stringify([...Object.keys(old.files), MANIFEST].sort())) throw Error('Unclassified destination files block refresh');
  for (const [file, hash] of Object.entries(old.files)) if (sha256(readFileSync(scopedPath(destination, file))) !== hash) throw Error('Out-of-band publication edit blocks refresh: ' + file);
  verifyPublicationHistory(destination);
  return old;
}
export function verifyOutput(destination, plan) {
  if (JSON.stringify(listOutput(destination)) !== JSON.stringify(Object.keys(plan.files).sort())) throw Error('Publication output file set differs from current canonical plan');
  const actual = Object.create(null);
  for (const [file, expected] of Object.entries(plan.files)) {
    const content = readFileSync(scopedPath(destination, file));
    if (!content.equals(expected)) throw Error('Stale or modified publication output: ' + file);
    actual[file] = content;
  }
  assertPublicationSafe(actual);
  return {status: 'OFFLINE-TESTED', files: Object.keys(actual).length, input_fingerprint: plan.inputFingerprint, history: verifyPublicationHistory(destination)};
}
export function writeOutput(destination, plan, canonicalRoot) {
  destination = assertDestination(destination, canonicalRoot);
  const old = assertOwned(destination);
  mkdirSync(destination, {recursive: true});
  // All inputs and projected bytes have passed the security gate before writes.
  // On any interrupted write, verify fails closed; an output is never marked safe by a log message.
  for (const [file, content] of Object.entries(plan.files)) {
    const output = scopedPath(destination, file);
    mkdirSync(dirname(output), {recursive: true});
    const temporary = output + '.tmp.' + randomUUID();
    writeFileSync(temporary, content, {flag: 'wx'});
    renameSync(temporary, output);
  }
  for (const file of Object.keys(old?.files || {})) {
    if (Object.hasOwn(plan.files, file)) continue;
    const output = scopedPath(destination, file);
    unlinkSync(output);
    let dir = dirname(output);
    while (dir !== destination && inside(destination, dir) && readdirSync(dir).length === 0) { rmdirSync(dir); dir = dirname(dir); }
  }
  return verifyOutput(destination, plan);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, target, ...extra] = process.argv.slice(2);
    if (!['export', 'verify'].includes(command) || !target || extra.length) throw Error('Usage: node scripts/publication.mjs <export|verify> <publication-directory>');
    const destination = assertDestination(target, ROOT);
    const before = planCanonical();
    const result = command === 'export' ? writeOutput(destination, before, ROOT) : verifyOutput(destination, before);
    const after = planCanonical();
    if (after.inputFingerprint !== before.inputFingerprint || after.manifest.canonical_base_commit !== before.manifest.canonical_base_commit) throw Error('Canonical inputs changed during operation; rerun export and verification');
    console.log(JSON.stringify({...result, destination, publication: 'NOT UPLOADED'}, null, 2));
  } catch (error) {
    console.error(JSON.stringify({status: 'BLOCKED', message: error.findings ? 'Publication security gate rejected files' : error.message, ...(error.findings ? {findings: error.findings} : {}), ...(error.paths ? {paths: error.paths} : {})}, null, 2));
    process.exitCode = 1;
  }
}
