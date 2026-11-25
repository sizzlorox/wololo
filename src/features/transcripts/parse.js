import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { walk } from '../../core/files.js';

/**
 * @typedef {{ role: 'user' | 'assistant', text: string, ts?: string }} Message
 * @typedef {{ file: string, harness: string, mtime: number, messages: Message[], raw: string }} Session
 */

/** Where each harness keeps its transcripts. Unknown formats fall back to the generic extractor. */
export function defaultSources(home = homedir()) {
  return [
    { harness: 'claude', dir: join(home, '.claude', 'projects') },
    { harness: 'codex', dir: join(home, '.codex', 'sessions') },
    { harness: 'copilot', dir: join(home, '.copilot', 'session-state') },
    { harness: 'gemini', dir: join(home, '.gemini', 'tmp') },
  ];
}

/**
 * @param {{ dirs?: string[], env?: NodeJS.ProcessEnv }} opts
 */
export function sources(opts) {
  const extra = [...(opts.dirs ?? []), ...(opts.env?.WOLOLO_TRANSCRIPTS?.split(/[:;]/).filter(Boolean) ?? [])];
  if (extra.length) return extra.map((d) => ({ harness: 'custom', dir: resolve(d) }));
  return defaultSources(opts.env?.HOME ?? homedir());
}

/**
 * @param {{ dirs?: string[], env?: NodeJS.ProcessEnv, project?: string, sinceDays?: number, limit?: number }} opts
 * @returns {Session[]}
 */
export function loadSessions(opts) {
  const cutoff = Date.now() - (opts.sinceDays ?? 90) * 864e5;
  /** @type {{ file: string, harness: string, mtime: number }[]} */
  const found = [];
  for (const src of sources(opts)) {
    for (const rel of walk(src.dir, src.dir)) {
      if (!/\.jsonl?$/.test(rel)) continue;
      const file = join(src.dir, rel);
      const st = statSync(file);
      if (st.mtimeMs < cutoff || st.size > 64 * 1024 * 1024) continue;
      found.push({ file, harness: src.harness === 'custom' ? guessHarness(file) : src.harness, mtime: st.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  /** @type {Session[]} */
  const sessions = [];
  for (const f of found) {
    if (sessions.length >= (opts.limit ?? 500)) break;
    const raw = readFileSync(f.file, 'utf8');
    if (opts.project && !belongsTo(f.file, raw, opts.project)) continue;
    const messages = parseMessages(raw);
    if (messages.length) sessions.push({ ...f, messages, raw });
  }
  return sessions;
}

/** @param {string} file */
function guessHarness(file) {
  if (file.includes('.claude')) return 'claude';
  if (file.includes('.codex') || /rollout-/.test(file)) return 'codex';
  if (file.includes('.copilot') || file.endsWith('events.jsonl')) return 'copilot';
  if (file.includes('.gemini')) return 'gemini';
  return 'unknown';
}

/**
 * @param {string} file
 * @param {string} raw
 * @param {string} project
 */
function belongsTo(file, raw, project) {
  const slug = project.replace(/[\\/.:_]/g, '-');
  if (file.includes(slug)) return true;
  const head = raw.slice(0, 512 * 1024);
  return head.includes(project) || head.includes(JSON.stringify(project).slice(1, -1));
}

/**
 * Parse JSONL or JSON transcripts of any supported harness into user/assistant text messages.
 * @param {string} raw
 * @returns {Message[]}
 */
export function parseMessages(raw) {
  /** @type {any[]} */
  let records = [];
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n{'))) {
    try {
      const doc = JSON.parse(raw);
      records = Array.isArray(doc) ? doc : Array.isArray(doc.messages) ? doc.messages : [doc];
    } catch {
      records = [];
    }
  }
  if (!records.length) {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip torn lines
      }
    }
  }
  /** @type {Message[]} */
  const out = [];
  for (const rec of records) {
    const m = toMessage(rec);
    if (!m) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && prev.text === m.text) continue;
    out.push(m);
  }
  return out;
}

/**
 * @param {any} rec
 * @returns {Message | undefined}
 */
function toMessage(rec) {
  if (!rec || typeof rec !== 'object') return undefined;
  const type = rec.type;
  let role =
    rec.role ??
    rec.message?.role ??
    rec.payload?.role ??
    (type === 'user.message' || type === 'user' ? 'user' : type === 'assistant.message' || type === 'assistant' || type === 'gemini' || type === 'model' ? 'assistant' : undefined);
  if (rec.payload?.type === 'user_message') role = 'user';
  if (role === 'model' || role === 'gemini') role = 'assistant';
  if (role !== 'user' && role !== 'assistant') return undefined;
  const content = rec.message?.content ?? rec.payload?.content ?? rec.payload?.message ?? rec.data?.content ?? rec.content ?? rec.text ?? rec.parts;
  const text = textOf(content).trim();
  if (!text) return undefined;
  if (role === 'user' && isInjected(text)) return undefined;
  return { role, text, ts: rec.timestamp ?? rec.ts ?? rec.data?.timestamp };
}

/** @param {any} content @returns {string} */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && (typeof p === 'string' || ['text', 'input_text', 'output_text'].includes(p.type) || (p.type === undefined && typeof p.text === 'string')))
    .map((p) => (typeof p === 'string' ? p : p.text))
    .join('\n');
}

/** Harness-injected context masquerading as user turns. @param {string} text */
function isInjected(text) {
  return /^<(?!-)[a-z_-]+[\s>]/i.test(text) || text.startsWith('Caveat:') || text.startsWith('# AGENTS.md') || text.startsWith('<environment_context>');
}

const CORRECTION =
  /\b(no|nope|don'?t|do not|stop|instead|wrong|actually|revert|undo|why did you|i said|i asked|not what|you forgot|you missed|you broke|again|never|shouldn'?t|that'?s not)\b|\[request interrupted/i;

/**
 * Human interventions: follow-up user turns that correct or redirect the agent.
 * @param {Session} s
 */
export function interventions(s) {
  const users = s.messages.filter((m) => m.role === 'user');
  return users.slice(1).filter((m) => CORRECTION.test(m.text));
}
