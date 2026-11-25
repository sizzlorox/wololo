import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../../core/files.js';
import { statePath } from '../../core/state.js';

/**
 * Per-run transcripts of what went to the model and what came back, written as the run goes,
 * one JSON line per entry in .wololo/state/runs/<id>.jsonl.
 *
 * What a transcript holds: wololo's prompt, every message the harness reports sending, the model's
 * thinking and replies, tool calls, and tool results (which go back to the model on the next turn).
 * What it cannot hold: the harness's own system prompt and tool schemas, which no harness streams.
 *
 * @typedef {object} Entry
 * @property {'prompt' | 'sent' | 'thinking' | 'reply' | 'call' | 'result' | 'endpoint' | 'delta' | 'note'} kind
 * @property {string} text
 * @property {string} [tool]
 * @property {boolean} [error]
 * @property {'thinking' | 'reply'} [of]   deltas: which block is streaming
 * @property {string} [at]
 */

/** Runs kept on disk; older ones are deleted. */
const KEEP = 200;
const dir = (/** @type {string} */ root) => statePath(root, 'runs');

/** @param {any} content */
const texts = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
      : '';

/**
 * Transcript entries in one stream event (omp `--mode json` or claude `stream-json`).
 * @param {any} e
 * @returns {Entry[]}
 */
export function entriesOf(e) {
  if (!e || typeof e !== 'object') return [];
  const m = e.message;
  // omp
  if (e.type === 'message_start' && m?.role === 'assistant' && (m.provider || m.api)) return [{ kind: 'endpoint', text: [m.provider, m.api, m.model].filter(Boolean).join(' · ') }];
  if (e.type === 'message_update') {
    const a = e.assistantMessageEvent;
    if (a?.type === 'thinking_delta') return [{ kind: 'delta', of: 'thinking', text: String(a.delta ?? '') }];
    if (a?.type === 'text_delta') return [{ kind: 'delta', of: 'reply', text: String(a.delta ?? '') }];
    return [];
  }
  if (e.type === 'message_end' && m?.role === 'user') return [{ kind: 'sent', text: texts(m.content) }];
  if (e.type === 'message_end' && m?.role === 'toolResult') return [{ kind: 'result', tool: String(m.toolName ?? ''), text: texts(m.content), error: Boolean(m.isError) }];
  // assistant blocks: omp message_end and claude assistant events share the shape
  if ((e.type === 'message_end' || e.type === 'assistant') && Array.isArray(m?.content) && (m.role === 'assistant' || e.type === 'assistant')) {
    return m.content.flatMap((/** @type {any} */ b) =>
      b.type === 'thinking' ? [{ kind: 'thinking', text: String(b.thinking ?? '') }]
      : b.type === 'text' ? [{ kind: 'reply', text: String(b.text ?? '') }]
      : b.type === 'toolCall' ? [{ kind: 'call', tool: String(b.name), text: JSON.stringify(b.arguments ?? {}) }]
      : b.type === 'tool_use' ? [{ kind: 'call', tool: String(b.name), text: JSON.stringify(b.input ?? {}) }]
      : [],
    );
  }
  // claude tool results come back as user messages
  if (e.type === 'user' && Array.isArray(m?.content)) {
    return m.content.filter((/** @type {any} */ b) => b.type === 'tool_result').map((/** @type {any} */ b) => ({ kind: 'result', text: texts(b.content), error: Boolean(b.is_error) }));
  }
  return [];
}

/** @param {string} root @param {string} id @param {Entry} entry */
const append = (root, id, entry) => appendFileSync(join(dir(root), `${id}.jsonl`), `${JSON.stringify(entry)}\n`);

/**
 * Record one agent run. The prompt goes first; deltas only feed `live()`, the finished block is stored.
 * @param {string} root @param {string} role @param {string} prompt
 */
export function recorder(root, role, prompt) {
  ensureDir(dir(root));
  const at = new Date().toISOString();
  // pid: parallel workers start agents in the same millisecond
  const id = `${at.replace(/[:.]/g, '-')}-${process.pid}-${role.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.replace(/-+$/, '').slice(0, 120);
  append(root, id, { kind: 'note', text: role, at });
  append(root, id, { kind: 'prompt', text: prompt, at });
  prune(root);
  let live = '';
  /** @type {'thinking' | 'reply' | undefined} */
  let liveOf;
  return {
    id,
    /** @param {Entry} e */
    add(e) {
      if (e.kind === 'delta') {
        if (e.of !== liveOf) live = '';
        liveOf = e.of;
        live += e.text;
        return;
      }
      if (e.kind === 'thinking' || e.kind === 'reply' || e.kind === 'call') live = '';
      if (e.kind === 'sent' && e.text === prompt) return; // the harness echoing wololo's prompt
      if (!e.text && e.kind !== 'result') return;
      append(root, id, { ...e, at: new Date().toISOString() });
    },
    live: () => live,
    liveOf: () => liveOf,
  };
}

/** @param {string} root */
function prune(root) {
  const files = readdirSync(dir(root)).filter((f) => f.endsWith('.jsonl')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) rmSync(join(dir(root), f), { force: true });
}

/** @param {string} root @param {string} id @returns {Entry[]} */
export function readRun(root, id) {
  const file = join(dir(root), `${id}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // a line being written right now
      }
    })
    .filter((e) => e.kind !== 'note');
}

/** Runs, newest first. @param {string} root @returns {{ id: string, role: string, at: string }[]} */
export function listRuns(root) {
  if (!existsSync(dir(root))) return [];
  return readdirSync(dir(root))
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .map((f) => {
      const id = f.slice(0, -6);
      const first = readFileSync(join(dir(root), f), 'utf8').split('\n', 1)[0];
      try {
        const note = JSON.parse(first);
        return { id, role: note.text, at: note.at };
      } catch {
        return { id, role: id, at: '' };
      }
    });
}

/** @type {{ kind: string, re: RegExp }[]} */
const SECRET = [
  { kind: 'bearer token', re: /Bearer\s+([A-Za-z0-9._~+/-]{16,})/g },
  { kind: 'API key', re: /\b((?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g },
  { kind: 'AWS key', re: /\b(AKIA[0-9A-Z]{16})\b/g },
  { kind: 'private key', re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g },
  { kind: 'password', re: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[=:]\s*["']([^\s"']{8,})["']/gi }, // quoted only: `token = getToken()` is code, not a secret
];

/**
 * Things that look like credentials. Previews show only the start, so the TUI never re-displays a whole secret.
 * @param {string} text
 * @returns {{ kind: string, preview: string }[]}
 */
export function secrets(text) {
  /** @type {{ kind: string, preview: string, at: number }[]} */
  const found = [];
  for (const { kind, re } of SECRET) for (const m of text.matchAll(re)) found.push({ kind, preview: `${m[1].slice(0, 7)}…`, at: m.index ?? 0 });
  return found.sort((a, b) => a.at - b.at).map(({ kind, preview }) => ({ kind, preview }));
}

/**
 * Before per-run transcripts existed, only the latest run survived, in agent-stream.log. Import it once.
 * @param {string} root
 * @returns {boolean} whether a run was imported
 */
export function importLastRun(root) {
  const stream = statePath(root, 'agent-stream.log');
  if (listRuns(root).length || !existsSync(stream)) return false;
  const headers = existsSync(statePath(root, 'autopilot.log')) ? [...readFileSync(statePath(root, 'autopilot.log'), 'utf8').matchAll(/^===== (\S+) (.+): \S+ =====$/gm)] : [];
  const last = headers.at(-1);
  /** @type {Entry[]} */
  const entries = readFileSync(stream, 'utf8')
    .split(/\r?\n/)
    .flatMap((l) => {
      try {
        return l.startsWith('{') ? entriesOf(JSON.parse(l)) : [];
      } catch {
        return [];
      }
    })
    .filter((e) => e.kind !== 'delta');
  if (!entries.length) return false;
  const first = entries.findIndex((e) => e.kind === 'sent');
  const prompt = first >= 0 ? entries.splice(first, 1)[0].text : '(prompt not in the stream)';
  const rec = recorder(root, `${last?.[2] ?? 'earlier run'} · imported`, prompt);
  for (const e of entries) rec.add(e);
  return true;
}
