import { gitOut } from '../../core/git.js';
import { appendFileSync, writeFileSync } from 'node:fs';
import { run } from '../../core/exec.js';
import { ensureDir } from '../../core/files.js';
import { rotate } from '../../core/rotate.js';
import { statePath } from '../../core/state.js';
import { parseLine } from './activity.js';
import { addActivity, count, setStatus } from './status.js';
import { meter, saveRun } from './usage.js';
import { readTask } from '../board/store.js';
import { entriesOf, recorder } from './transcript.js';

export const DEFAULT_TIMEOUT_MINUTES = 45;
export const DEFAULT_STALL_MINUTES = 20;
const SPINNER = /^(working|thinking)\.*$/i;
/** Compactions in a row with no tool call or answer between them: the context cannot fit the window. */
export const COMPACTION_LOOP = 3;
export const CONTEXT_LOOP = 'stuck in a compaction loop';
export const CIRCLES = 'going in circles';
/** A compaction loop where every reply was cut off at the output cap: more context cannot help. */
export const OUTPUT_CAP = 'replies cut off at the output limit';
/** Tool calls with no edit (and no file change on disk) before a run counts as going in circles... */
export const CIRCLE_CALLS = 24;
/** ...when at least this many of them repeat an earlier call verbatim. */
export const CIRCLE_REPEATS = 8;
const EDIT_TOOL = /edit|write|patch|create|replace|notebook/i;
const SERVER_ERROR = /retrying \(|server_error|"code":\s*5\d\d|econnrefused|econnreset|fetch failed|socket hang up/i;

/**
 * What to do about a model server that keeps failing. Local servers (LM Studio, llama.cpp) fail in
 * ways the agent CLI only retries, so the run would otherwise sit there until the time limit.
 * @param {string} error
 */
export function serverHint(error) {
  if (/speculative/i.test(error)) return 'This is a speculative-decoding (draft model) error in the model server: turn speculative decoding off (LM Studio: remove the draft model; llama.cpp: drop --model-draft/-md) or update the server.';
  return 'Check the model server: is it running, reachable and not out of memory? Its own log says more.';
}
/** What to do when replies keep getting cut off at the output cap. */
/** How to raise the output cap itself. */
export const OUTPUT_CAP_FIX = 'raise the output limit: omp sends the model\'s maxTokens (~/.omp/agent/models.yml, e.g. modelOverrides maxTokens: 16384), and the server has its own (llama.cpp -n / n_predict, LM Studio max tokens).';
export const OUTPUT_CAP_HINT = `Lower the thinking level (autopilot.thinking: "minimal" or "off"; small windows default to "low") and make sure the model honours it (omp models.yml thinkingFormat, e.g. qwen-chat-template), or ${OUTPUT_CAP_FIX}`;
const HEARTBEAT_MS = Number(process.env.WOLOLO_HEARTBEAT_MS) || 5 * 60_000;
/** Echo each activity line to the console as it happens (WOLOLO_QUIET=1 for heartbeats only). */
const STREAM = !process.env.WOLOLO_QUIET;


/**
 * What the agent has actually done so far, from git: agents in headless mode mostly print a spinner.
 * @param {string} root
 * @param {string} base  HEAD when the agent started
 */
export function progress(root, base) {
  const dirty = gitOut(root, ['status', '--porcelain']).split('\n').filter(Boolean).length;
  const commits = base ? gitOut(root, ['log', '--format=%s', `${base}..HEAD`]).split('\n').filter(Boolean) : [];
  return `${dirty} uncommitted file(s), ${commits.length ? `${commits.length} commit(s), last: "${commits[0].slice(0, 80)}"` : 'no commits yet'}`;
}

/**
 * Run one headless agent: bounded in time, its output kept in .wololo/state/autopilot.log,
 * and a heartbeat so a long run is visibly alive (or visibly stuck).
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string[]} argv
 * @param {string} role
 * @param {(msg: string) => void} log
 * @param {{ task?: string, learned?: string[] }} [meta]  recorded with the run's usage: its step, and the learned skills it was given
 * @returns {Promise<import('../../core/exec.js').ExecResult & { unfinished?: string, raw: string, cutoff?: number }>}  `unfinished` says why the agent did not end on its own; `raw` is stdout before streamed JSON became the answer; `cutoff` is the most output tokens a cut-off reply had
 */
export async function runAgent(ctx, argv, role, log, meta = {}) {
  const minutes = ctx.config.autopilot.agentTimeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  ensureDir(statePath(ctx.root));
  const file = statePath(ctx.root, 'autopilot.log');
  const raw = statePath(ctx.root, 'agent-stream.log');
  // ponytail: 5MB per log, 3 generations; make it a setting if someone needs more history
  rotate(file, 5 * 1024 * 1024);
  rotate(raw, 5 * 1024 * 1024);
  appendFileSync(file, `\n===== ${new Date().toISOString()} ${role}: ${argv[0]} =====\n`);
  writeFileSync(raw, '');
  let last = '';
  let text = '';
  let pending = '';
  let streamed = false;
  const spent = meter();
  // ponytail: the prompt is the longest argv entry for every harness wololo drives
  const prompt = argv.reduce((a, b) => (b.length > a.length ? b : a), '');
  const worker = process.env.WOLOLO_WORKER;
  const label = worker ? `${role} · ${readTask(ctx.root, worker)?.title ?? worker}` : role;
  const transcript = recorder(ctx.root, label, prompt);
  // usage is saved from the first moment, then after every turn: a run that never ends still counts
  const usageRecord = () => ({ type: /** @type {'agent'} */ ('agent'), id: transcript.id, transcript: transcript.id, role: label, ts: new Date(started).toISOString(), promptChars: prompt.length, model, live: true, task: meta.task ?? worker, learned: meta.learned ?? [], ...spent.summary() });
  let liveShown = 0;
  /** @type {string | undefined} */
  let model;
  let serverError = '';
  const started = Date.now();
  saveRun(ctx.root, usageRecord());
  const base = gitOut(ctx.root, ['rev-parse', 'HEAD']);
  const stallMinutes = ctx.config.autopilot.stallMinutes ?? DEFAULT_STALL_MINUTES;
  const stallMs = stallMinutes * 60_000;
  const abort = new AbortController();
  let stalled = false;
  let compactions = 0;
  /** Of those, compactions because a reply hit the output cap (omp reason "incomplete"). */
  let capped = 0;
  /** The most output tokens a reply had when it was cut off at the output cap. */
  let cutoff = 0;
  let looping = false;
  /** Tool calls since the last edit or file change. @type {string[]} */
  let calls = [];
  let circling = '';
  let lastProgress = started;
  /** HEAD plus the working tree: changes here are progress even when the agent prints nothing. */
  const tree = () => `${gitOut(ctx.root, ['rev-parse', 'HEAD'])}\n${gitOut(ctx.root, ['status', '--porcelain'])}`;
  let lastTree = tree();
  const watchdog = stallMs > 0
    ? setInterval(() => {
        const now = tree();
        if (now !== lastTree) {
          lastTree = now;
          lastProgress = Date.now();
          calls = [];
          show({ idleSince: new Date(lastProgress).toISOString() });
        } else if (Date.now() - lastProgress >= stallMs && !stalled) {
          stalled = true;
          abort.abort();
        }
      }, Math.min(60_000, Math.max(100, stallMs / 4)))
    : undefined;
  /** @type {import('./status.js').AgentRun} */
  const shown = { role, started: new Date(started).toISOString(), timeoutMinutes: minutes, base, calls: 0, edits: 0, compactions: 0, idleSince: new Date(started).toISOString(), transcript: transcript.id };
  /** @param {Partial<import('./status.js').AgentRun>} patch */
  const show = (patch) => {
    Object.assign(shown, patch);
    setStatus(ctx.root, { agent: { ...shown } });
  };
  show({});
  count(ctx.root, role.split(' (')[0]);
  /** @param {string} line */
  const consume = (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) streamed = true;
    const a = parseLine(line);
    if (trimmed.startsWith('{')) {
      try {
        for (const e of entriesOf(JSON.parse(trimmed))) transcript.add(e);
      } catch {
        // not JSON
      }
      // the model's thinking as it streams, for the TUI; throttled, deltas arrive per token
      if (Date.now() - liveShown > 250) {
        liveShown = Date.now();
        show({ live: transcript.live().slice(-2000), liveOf: transcript.liveOf() });
      }
    }
    if (a.usage) {
      spent.add(a.usage);
      saveRun(ctx.root, usageRecord());
      const u = spent.summary();
      show({ usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost, turns: u.turns } });
    }
    if (a.model && a.model !== model) setStatus(ctx.root, { model: (model = a.model) });
    if (SERVER_ERROR.test(trimmed)) {
      serverError = trimmed.slice(0, 300);
      show({ error: serverError });
    } else if (a.kind === 'work' || (!a.kind && trimmed && !SPINNER.test(trimmed))) lastProgress = Date.now();
    if (a.tool) show({ calls: (shown.calls ?? 0) + 1, edits: (shown.edits ?? 0) + (EDIT_TOOL.test(a.tool) ? 1 : 0), idleSince: new Date(lastProgress).toISOString() });
    if (a.kind === 'compact' && a.say?.startsWith('compacting')) show({ compactions: (shown.compactions ?? 0) + 1 });
    if (a.kind === 'work') compactions = capped = 0;
    if (a.tool && a.say) {
      if (EDIT_TOOL.test(a.tool)) calls = [];
      else calls.push(a.say);
      const repeats = calls.length - new Set(calls).size;
      if (calls.length >= CIRCLE_CALLS && repeats >= CIRCLE_REPEATS && !circling && !looping) {
        const counts = new Map();
        for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1);
        const top = [...counts].sort((x, y) => y[1] - x[1])[0][0];
        circling = `${calls.length} tool calls with no edits, ${repeats} of them repeats (e.g. ${top})`;
        abort.abort();
      }
    }
    if (a.cutoff !== undefined) cutoff = Math.max(cutoff, a.cutoff);
    if (a.kind === 'compact' && a.say?.startsWith('compacting') && a.say.includes('(incomplete)')) capped++;
    if (a.kind === 'compact' && a.say?.startsWith('compacting') && ++compactions >= COMPACTION_LOOP && !looping) {
      looping = true;
      abort.abort();
    }
    if (a.text !== undefined) text = a.text;
    if (a.tokens) show({ tokens: a.tokens, idleSince: new Date(lastProgress).toISOString() });
    if (!a.say) return;
    last = a.say;
    appendFileSync(file, `${a.say}\n`);
    addActivity(ctx.root, a.say);
    if (STREAM) process.stderr.write(`  ${role} · ${a.say}\n`);
  };
  const beat = setInterval(() => log(`${role} still running (${Math.round((Date.now() - started) / 60_000)}m): ${progress(ctx.root, base)}${last ? `; last: ${last}` : ''}`), HEARTBEAT_MS);
  const r = await run(argv, {
    cwd: ctx.root,
    timeoutMs: minutes > 0 ? minutes * 60_000 : undefined,
    signal: abort.signal,
    onData: (chunk) => {
      appendFileSync(raw, chunk);
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? '';
      lines.forEach(consume);
    },
  });
  if (pending) consume(pending);
  clearInterval(beat);
  clearInterval(watchdog);
  setStatus(ctx.root, { agent: null });
  const failing = serverError ? ` Likely cause: the model server keeps failing: ${serverError}. ${serverHint(serverError)}` : '';
  if (circling) {
    const msg = `${role} is going in circles: ${circling}. With a small context it forgets what it read and reads it again. Killed (${progress(ctx.root, base)}); a fresh agent continues from the files on disk.`;
    appendFileSync(file, `\n[wololo] ${msg}\n`);
    log(msg);
  } else if (looping) {
    const why = capped >= compactions
      ? `its replies keep hitting the model's output-token limit before it acts (omp: "compacting context (incomplete)"${cutoff ? `, cut off at ${cutoff} output tokens` : ''}), usually because it thinks too long. ${OUTPUT_CAP_HINT}`
      : `its context no longer fits the window even after compacting. If this repeats, split the task or give the model a bigger context.`;
    const msg = `${role} is stuck in a compaction loop: ${compactions} compactions with no work in between: ${why} Killed (${progress(ctx.root, base)}); a fresh context starts over from the files on disk.`;
    appendFileSync(file, `\n[wololo] ${msg}\n`);
    log(msg);
  } else if (stalled) {
    const msg = `${role} stalled: no progress for ${stallMinutes}m (no output, no file changes) and was killed (${progress(ctx.root, base)}${last ? `; last: ${last}` : ''}).${failing} Raise autopilot.stallMinutes if agents legitimately go quiet that long (0 = off).`;
    appendFileSync(file, `\n[wololo] ${msg}\n`);
    log(msg);
  }
  if (r.timedOut) {
    const msg = `${role} timed out after ${minutes}m and was killed (${progress(ctx.root, base)}${last ? `; last: ${last}` : ''}).${failing} The task goes on: the gate decides what happens next. Full output: ${file}; raise autopilot.agentTimeoutMinutes if agents need longer`;
    appendFileSync(file, `\n[wololo] ${msg}\n`);
    log(msg);
  }
  const killed = circling ? 'circles' : looping ? 'compaction loop' : stalled ? 'stalled' : r.timedOut ? 'timeout' : '';
  if (killed) count(ctx.root, `killed: ${killed}`);
  // ponytail: the prompt is the longest argv entry for every harness wololo drives; plumb it through if one ever reads it from stdin
  saveRun(ctx.root, { ...usageRecord(), live: false, ...(killed ? { killed } : {}) });
  const unfinished = circling ? CIRCLES : looping ? (capped >= compactions ? OUTPUT_CAP : CONTEXT_LOOP) : r.timedOut ? `timed out after ${minutes}m` : stalled ? `stalled for ${stallMinutes}m` : r.code !== 0 ? `exited ${r.code}` : undefined;
  // Streamed JSON is for machines; callers show the agent's answer (and stderr, where errors go).
  return { ...r, ...(streamed ? { stdout: text } : {}), raw: r.stdout, unfinished, ...(cutoff ? { cutoff } : {}) };
}
