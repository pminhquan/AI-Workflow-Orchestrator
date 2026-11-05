import {inScope} from '../core/util.mjs';
import {boundedJSON,canonicalWorkspace,noKnownSecrets,validateScopePath} from './contracts.mjs';

export const SUBTASK_AGENT_TYPES = ['research', 'implementer', 'tester', 'reviewer'];

const SUBTASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const MAX_SUBTASKS_BYTES = 6144;

function normalizeScopeList(paths = [], workspace, allowedScope, fieldName, subtaskId) {
  if (!Array.isArray(paths)) throw Error(`Subtask ${fieldName} must be an array: ${subtaskId}`);
  const seen = new Set();
  const normalized = [];
  for (const p of paths) {
    if (typeof p !== 'string') throw Error(`Subtask ${fieldName} entry must be a string: ${subtaskId}`);
    const lower = p.toLowerCase();
    if (seen.has(lower)) throw Error(`Case-aliased duplicate scope path in subtask ${subtaskId}: ${p}`);
    seen.add(lower);
    validateScopePath(workspace, p);
    if (!inScope(p, allowedScope)) throw Error(`Subtask ${fieldName} path outside job scope (${subtaskId}): ${p}`);
    normalized.push(p);
  }
  return normalized;
}

export function validateSubtaskPlan(subtasks, { readScope = [], writeScope = [], workspaceRoot } = {}) {
  if (!Array.isArray(subtasks) || subtasks.length < 1 || subtasks.length > 8) {
    throw Error('Subtasks must be an array of 1..8 items');
  }
  boundedJSON(subtasks, MAX_SUBTASKS_BYTES, 'Subtasks');
  noKnownSecrets(subtasks);
  if (!Array.isArray(readScope) || !Array.isArray(writeScope)) {
    throw Error('Parent readScope and writeScope must be arrays');
  }
  const workspace = canonicalWorkspace(workspaceRoot);
  const parentReadableScope = [...readScope, ...writeScope];
  const seenIds = new Set();

  const normalized = subtasks.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw Error('Each subtask must be an object');
    }
    const id = raw.id;
    if (typeof id !== 'string' || !SUBTASK_ID_PATTERN.test(id)) {
      throw Error('Invalid subtask id');
    }
    const lowerId = id.toLowerCase();
    if (seenIds.has(lowerId)) {
      throw Error(`Duplicate subtask id: ${id}`);
    }
    seenIds.add(lowerId);

    if (typeof raw.title !== 'string' || /[\x00-\x1f\x7f]/.test(raw.title)) {
      throw Error(`Invalid subtask title: ${id}`);
    }
    const title = raw.title.trim();
    if (!title || title.length > 120) {
      throw Error(`Subtask title must be 1..120 characters: ${id}`);
    }

    if (typeof raw.goal !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw.goal)) {
      throw Error(`Invalid subtask goal: ${id}`);
    }
    const goal = raw.goal.trim();
    if (!goal || goal.length > 1000) {
      throw Error(`Subtask goal must be 1..1000 characters: ${id}`);
    }

    const wave = raw.wave === undefined ? 1 : raw.wave;
    if (!Number.isInteger(wave) || wave < 1 || wave > 8) {
      throw Error(`Subtask wave must be an integer 1..8: ${id}`);
    }

    const normalizedReadScope = normalizeScopeList(raw.read_scope, workspace, parentReadableScope, 'read_scope', id);
    const normalizedWriteScope = normalizeScopeList(raw.write_scope, workspace, writeScope, 'write_scope', id);

    const agentType = raw.agent_type === undefined
      ? (normalizedWriteScope.length ? 'implementer' : 'research')
      : raw.agent_type;
    if (typeof agentType !== 'string' || !SUBTASK_AGENT_TYPES.includes(agentType)) {
      throw Error(`Invalid subtask agent_type: ${id}`);
    }
    if ((agentType === 'research' || agentType === 'reviewer') && normalizedWriteScope.length > 0) {
      throw Error('Read-only subtask agent_type cannot declare write_scope: ' + id);
    }

    return {
      id,
      title,
      goal,
      wave,
      agent_type: agentType,
      read_scope: normalizedReadScope,
      write_scope: normalizedWriteScope,
      antigravity_dispatch: {
        tool: 'invoke_subagent',
        type_name: normalizedWriteScope.length ? 'self' : 'research',
        workspace_mode: 'inherit',
        role_title: title.slice(0, 48)
      }
    };
  });

  const sortedWaveNumbers = [...new Set(normalized.map(s => s.wave))].sort((a, b) => a - b);
  const waves = sortedWaveNumbers.map(wave => {
    const group = normalized.filter(s => s.wave === wave);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a.id === b.id) continue;
        for (const pa of a.write_scope) {
          for (const pb of b.write_scope) {
            if (inScope(pa, [pb]) || inScope(pb, [pa])) {
              throw Error(`Overlapping subtask write_scope in wave ${wave}: ${a.id} vs ${b.id}`);
            }
          }
        }
      }
    }
    return {
      wave,
      parallel: group.length > 1,
      subtasks: group
    };
  });

  return {
    total_subtasks: normalized.length,
    max_parallelism: Math.max(...waves.map(w => w.subtasks.length)),
    waves
  };
}

function formatScope(paths, emptyLabel = '(none)') {
  return paths && paths.length ? paths.map(p => `\`${p}\``).join(', ') : emptyLabel;
}

export function renderSubtaskPlanMarkdown(plan) {
  if (!plan || !Array.isArray(plan.waves) || plan.waves.length === 0) return '';
  const lines = [
    '## Antigravity Subtask Plan (Team Lead Dispatch)',
    '',
    `- **Total subtasks:** ${plan.total_subtasks}`,
    `- **Max parallelism:** ${plan.max_parallelism}`,
    '- **Execution protocol:** Execute waves strictly in ascending order (`Wave 1`, `Wave 2`, ...). Within a parallel wave, dispatch all subtasks **in parallel in a single turn** using `invoke_subagent` (`workspace_mode: "inherit"`), wait for every subagent in that wave to finish, verify their changes/findings, and only then start the next wave.',
    ''
  ];

  for (const waveEntry of plan.waves) {
    const modeNote = waveEntry.parallel
      ? `Parallel — dispatch all ${waveEntry.subtasks.length} subtasks in a single turn via \`invoke_subagent\``
      : 'Single subtask — dispatch via `invoke_subagent` (or execute bounded scope)';
    lines.push(`### Wave ${waveEntry.wave} (${modeNote})`);
    lines.push('');
    for (const sub of waveEntry.subtasks) {
      const dispatch = sub.antigravity_dispatch ?? {
        tool: 'invoke_subagent',
        type_name: sub.write_scope?.length ? 'self' : 'research',
        workspace_mode: 'inherit',
        role_title: String(sub.title ?? '').slice(0, 48)
      };
      lines.push(`#### Subtask \`${sub.id}\`: ${sub.title}`);
      lines.push(`- **Dispatch:** \`${dispatch.tool}\` — \`type_name: "${dispatch.type_name}"\`, \`workspace_mode: "${dispatch.workspace_mode}"\`, \`agent_type: "${sub.agent_type}"\``);
      lines.push(`- **read_scope:** ${formatScope(sub.read_scope)}`);
      lines.push(`- **write_scope:** ${formatScope(sub.write_scope, '(none — read-only)')}`);
      lines.push(`- **goal:** ${sub.goal}`);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}
