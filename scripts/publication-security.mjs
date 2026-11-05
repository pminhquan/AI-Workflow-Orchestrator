// Conservative publication gate, not a replacement for provider secret protection.
// Findings contain locations and rule names only, never matched values.
const secretRules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{30,255})\b/g],
  ['aws-access-id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ['google-oauth-token', /\b(?:GOCSPX-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_.-]{20,})\b/g],
  ['ai-api-token', /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ['vendor-token', /\b(?:xox[baprs]-[A-Za-z0-9-]{15,}|npm_[A-Za-z0-9]{25,}|pypi-[A-Za-z0-9_-]{25,}|glpat-[A-Za-z0-9_-]{15,}|hf_[A-Za-z0-9]{25,}|[sr]k_live_[A-Za-z0-9]{16,})\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['url-credential', /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s\/@:]+:[^\s\/@]+@/gi],
  ['authorization-value', /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=-]{16,}/gi],
  ['cookie-value', /\b(?:sessionid|session_token|connect\.sid|SAPISID|__Secure-[A-Za-z_-]*session[A-Za-z_-]*)=[A-Za-z0-9%+/_=.-]{12,}/gi],
  ['secret-assignment', /["']?\b[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|worker[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|password|passwd|private[_-]?key|cookie|authorization|secret|token)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']([^"'\r\n]{3,})["']/gi],
  ['capability-assignment', /(?:["'](?:[A-Za-z0-9_-]*(?:worker|bridge|mcp|bearer|auth)[_-]?)?capabilit(?:y|ies)["']\s*:|(?:^|[,{])\s*(?:[A-Za-z0-9_-]*(?:worker|bridge|mcp|bearer|auth)[_-]?)?capabilit(?:y|ies)\s*:|\b(?:[A-Za-z0-9_-]*(?:worker|bridge|mcp|bearer|auth)[_-]?)?capabilit(?:y|ies)\s*=)\s*["']([^"'\r\n]{3,})["']/gmi],
];
const machinePath = /(?:\b[A-Z]:[\\/]+(?:Users|PROJECT|workspace|repos?)[\\/]+|\/(?:Users|home)\/[^\s/]+\/)/gi;
const privateName = /(?:^|\/)(?:\.env(?:\..+)?|auth(?:\.[^/]+)?\.json|credentials[^/]*|tokens?\.(?:json|txt)|mcp_config\.json|bridge\.config\.json|id_rsa[^/]*|id_ed25519[^/]*|[^/]+\.(?:sqlite\w*|db(?:-\w+)?|pem|key|p12|pfx|zip|7z|bak))$/i;

function synthetic(file, value) {
  if (/^<[_A-Z][A-Z0-9_]*>$/.test(value)) return true;
  return /^tests\//.test(file) && ['not-a-real-token', 'synthetic-rejected'].includes(value);
}
function publicSourceToken(content, offset, token) {
  const line = content.slice(content.lastIndexOf('\n', offset) + 1, content.indexOf('\n', offset) < 0 ? undefined : content.indexOf('\n', offset));
  return [...line.matchAll(/https?:\/\/[^\s"'<>)]*/g)].some(match => {
    try {
      const url = new URL(match[0]);
      return ['github.com', 'raw.githubusercontent.com'].includes(url.hostname) && !url.username && !url.password && !url.search && /\/[0-9a-f]{40}(?:\/|$)/i.test(url.pathname) && match[0].includes(token);
    } catch { return false; }
  });
}

export function scanPublicationFile(file, buffer, {machineMetadata = false} = {}) {
  const findings = [];
  const add = (type, offset = 0) => findings.push({path: file, line: buffer.subarray(0, offset).toString('utf8').split('\n').length, type});
  if (privateName.test(file) && file !== '.env.example') add('private-or-runtime-filename');
  if (/(?:^|\/)(?:\.git|\.codex|\.gemini|\.antigravity|sessions|transcripts|runtime|logs|backups?)(?:\/|$)/i.test(file) || file.startsWith('state/') && file !== 'state/README.md') add('private-runtime-path');
  if (buffer.length > 1024 * 1024) add('file-over-1-MiB');
  if (buffer.includes(0)) { add('binary-or-non-UTF8-text'); return findings; }
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) add('invalid-UTF8');
  for (const [type, regex] of secretRules) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      if (type === 'secret-assignment' && synthetic(file, match[1])) continue;
      add(type, match.index);
    }
  }
  if (/\.(?:ya?ml|toml|ini|properties)$|(?:^|\/)\.env(?:\.|$)/i.test(file)) {
    const unquoted = /^\s*[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|capability)[A-Za-z0-9_.-]*\s*[:=]\s*([^\s"'#[{][^\r\n#]*)$/gmi;
    for (const match of text.matchAll(unquoted)) {
      const value = match[1].trim();
      if (!/^(?:true|false|null|none|\d+|\$\{[A-Z_][A-Z0-9_]*\})$/i.test(value) && !synthetic(file, value)) add('unquoted-secret-assignment', match.index);
    }
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9+/_=-]{32,}\b/g)) {
    const value = match[0];
    if (/^[a-f0-9]{32,128}$/i.test(value) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) continue;
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) continue;
    const counts = {};
    for (const char of value) counts[char] = (counts[char] || 0) + 1;
    const entropy = Object.values(counts).reduce((sum, n) => sum - n / value.length * Math.log2(n / value.length), 0);
    if (entropy > 4.6 && !publicSourceToken(text, match.index, value)) add('unclassified-high-entropy-value', match.index);
  }
  if (!machineMetadata) {
    machinePath.lastIndex = 0;
    for (const match of text.matchAll(machinePath)) add('machine-specific-path', match.index);
    for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
      if (!/@users\.noreply\.github\.com$|@example\.(?:com|org|net)$/i.test(match[0])) add('email-needs-privacy-review', match.index);
    }
  }
  return findings;
}

export function assertPublicationSafe(files, options = {}) {
  const findings = Object.entries(files).flatMap(([file, content]) => scanPublicationFile(file, Buffer.from(content), options));
  if (findings.length) {
    const error = new Error('Publication security gate rejected files');
    error.findings = findings;
    throw error;
  }
}
