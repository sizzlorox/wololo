// Peer hook for parallel autopilot workers. Dependency-free CommonJS: it runs after every tool call.
//
// - pre:  before an edit, refuse (once) a file that another running step claimed in its `touches`.
//         Doing it anyway is allowed, and announced to the other agents.
// - post: after any tool call, hand the agent new messages from the other agents (task notes, merges).
//
// Environment (set by the orchestrator on each worker): WOLOLO_WORKER (this task id), WOLOLO_GROUP,
// WOLOLO_STATE (the main repo's .wololo/state). Without WOLOLO_WORKER it does nothing.
//
// Used two ways: omp loads peers-omp.js (--hook), which calls pre/post in-process; Claude Code runs
// `node peers.cjs pre|post` from per-run --settings hooks and gets hook JSON on stdout.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const EDIT_TOOLS = /^(edit|write|multiedit|multi_edit|notebookedit|notebook|ast_edit|str_replace_based_edit_tool|apply_patch)$/i;

/** @param {string} p */
const posix = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Does a file fall under a claim? A claim is a file, a dir (whole segments), or a glob with * and **.
 * @param {string} file  relative, posix
 * @param {string} claim
 */
function matches(file, claim) {
  const c = posix(claim).replace(/\/+$/, '');
  if (!c) return false;
  if (c.includes('*')) {
    const re = new RegExp(`^${c.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
    return re.test(file);
  }
  return file === c || file.startsWith(`${c}/`);
}

/** @param {string} file @param {any} fallback */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** @param {NodeJS.ProcessEnv} env */
const where = (env) => ({ state: env.WOLOLO_STATE || '', group: env.WOLOLO_GROUP || '', me: env.WOLOLO_WORKER || '' });

/** @param {NodeJS.ProcessEnv} env @param {string} text */
function announce(env, text) {
  const { state, group, me } = where(env);
  const claims = readJson(path.join(state, 'claims', `${group}.json`), {});
  fs.mkdirSync(path.join(state, 'inbox'), { recursive: true });
  fs.appendFileSync(path.join(state, 'inbox', `${group}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), from: me, title: claims[me]?.title ?? me, text })}\n`);
}

/** Every path an edit tool's input names. @param {any} input */
function pathsOf(input) {
  if (!input || typeof input !== 'object') return [];
  const one = [input.path, input.file_path, input.notebook_path, input.filePath].filter((p) => typeof p === 'string');
  const many = Array.isArray(input.edits) ? input.edits.flatMap((e) => pathsOf(e)) : [];
  return [...one, ...many];
}

/**
 * @param {string} tool @param {any} input @param {string} cwd  the worktree root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} a reason to block, or '' to allow
 */
function pre(tool, input, cwd, env = process.env) {
  const { state, group, me } = where(env);
  if (!me || !state || !group || !EDIT_TOOLS.test(String(tool))) return '';
  const claims = readJson(path.join(state, 'claims', `${group}.json`), {});
  const warnedFile = path.join(state, 'inbox', `${me}.warned.json`);
  const warned = readJson(warnedFile, []);
  for (const raw of pathsOf(input)) {
    const file = posix(path.isAbsolute(raw) ? path.relative(cwd, raw) : raw);
    if (file.startsWith('../')) continue;
    for (const [id, c] of Object.entries(claims)) {
      if (id === me || !(c.touches ?? []).some((/** @type {string} */ t) => matches(file, t))) continue;
      if (warned.includes(file)) {
        announce(env, `also edited ${file}, which "${c.title}" (${id}) is changing: check the merge`);
        continue;
      }
      fs.mkdirSync(path.dirname(warnedFile), { recursive: true });
      fs.writeFileSync(warnedFile, JSON.stringify([...warned, file]));
      return [
        `${file} is being changed by "${c.title}" (${id}), another agent building this plan in parallel. Editing it too will likely conflict when both are merged.`,
        `Prefer working around it in your own files. If you need a change there, ask for it: \`task note ${me} "<what you need in ${file}>"\` reaches that agent.`,
        'If you must edit it anyway, repeat the edit: it will go through and the other agent will be told.',
      ].join('\n');
    }
  }
  return '';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} new messages from the other agents, or ''
 */
function post(env = process.env) {
  const { state, group, me } = where(env);
  if (!me || !state || !group) return '';
  const inbox = path.join(state, 'inbox', `${group}.jsonl`);
  const cursorFile = path.join(state, 'inbox', `${me}.cursor`);
  let size = 0;
  try {
    size = fs.statSync(inbox).size;
  } catch {
    return '';
  }
  const from = Number(readJson(cursorFile, 0)) || 0;
  if (size <= from) return '';
  const fd = fs.openSync(inbox, 'r');
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const end = text.lastIndexOf('\n') + 1; // a line still being written waits for next time
  fs.writeFileSync(cursorFile, String(from + Buffer.byteLength(text.slice(0, end))));
  const lines = text
    .slice(0, end)
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    })
    .filter((m) => m.from !== me)
    .map((m) => `- ${m.from === 'wololo' ? 'wololo' : `${m.title} (${m.from})`}: ${m.text}`);
  return lines.length ? ['Messages from the agents building the other steps of this plan in parallel:', ...lines].join('\n') : '';
}

module.exports = { matches, pre, post };

// Claude Code: `node peers.cjs pre|post`, hook payload on stdin.
if (require.main === module) {
  const mode = process.argv[2];
  let raw = '';
  process.stdin.on('data', (b) => (raw += b));
  process.stdin.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      // no payload
    }
    const cwd = payload.cwd || process.cwd();
    if (mode === 'pre') {
      const reason = pre(payload.tool_name, payload.tool_input, cwd);
      if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    } else if (mode === 'post') {
      const context = post();
      if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
    }
  });
}
