import { git, gitOut } from '../../core/git.js';
import { sh } from '../../core/exec.js';
import { recordEvent } from '../../core/state.js';
import { shortHash, tail } from '../../core/text.js';
import { commands as boardCommands } from '../board/command.js';
import { runGate } from '../gate/command.js';
import { clip, contextRules, failureBudget, overflowHint } from './budget.js';
import { count, noteEverywhere, setStatus } from './status.js';
import { builderPrompt, fixerPrompt, verifierPrompt } from './prompts.js';
import { refreshConfig } from './adopt.js';
import { CONTEXT_LOOP, OUTPUT_CAP, OUTPUT_CAP_FIX, runAgent } from './agent.js';
import { agentArgv } from './argv.js';
import { learnedFor } from '../learn/store.js';
import { hillClimb } from './climb.js';

const board = Object.fromEntries(boardCommands.map((c) => [c.name, c]));

export const UNVERIFIABLE =
  'nothing can be verified yet: no verify steps and no project wololo recognises (package.json, Cargo.toml, pyproject.toml, go.mod). Scaffold the project with a test command, or set verify.steps in wololo.config.json';

/**
 * Subjects of the commits made since `base`, newest first.
 * @param {string} root
 * @param {string} base
 */
const commitsSince = (root, base) =>
  base ? (git(root, ['log', '--format=%s', `${base}..HEAD`]).stdout ?? '').split('\n').filter(Boolean).slice(0, 15) : [];

/**
 * Uncommitted files (`git status --short`), so a fresh agent knows what was left without exploring.
 * @param {string} root
 */
export const dirtyFiles = (root) =>
  (git(root, ['status', '--short', '--untracked-files=all', '--', '.', ':(exclude).wololo']).stdout ?? '').split('\n').filter(Boolean).slice(0, 30);

/** @param {string} msg */
export const log = (msg) => {
  process.stderr.write(`[autopilot] ${msg}\n`);
  noteEverywhere(msg);
};

/**
 * Content fingerprint: the committed tree plus uncommitted changes. Commits that restore an
 * earlier state hash the same, which is how verifier ping-pong is caught.
 * @param {string} root
 */
function fingerprint(root) {
  return shortHash(gitOut(root, ['rev-parse', 'HEAD^{tree}']) + gitOut(root, ['status', '--porcelain']) + gitOut(root, ['diff', 'HEAD']));
}

/** Same failure modulo timings, counts and line numbers. @param {string} failures */
const failureKey = (failures) => shortHash(failures.replace(/\d+(\.\d+)?/g, 'N'));

const DOCS = /(^|\/)docs\/|\.(md|mdx|txt|rst)$/i;

/**
 * Everything the task changed (commits since it started plus the working tree) is documentation.
 * @param {string} root
 * @param {string} base
 */
function docsOnly(root, base) {
  if (!base) return false;
  /** @param {string[]} args */
  const lines = (args) => (git(root, args).stdout ?? '').split('\n').filter(Boolean);
  const files = [...lines(['diff', '--name-only', base]), ...lines(['ls-files', '--others', '--exclude-standard'])];
  return files.length > 0 && files.every((f) => DOCS.test(f));
}

/**
 * `verify: FAIL cargo-test; rubric: score 0.5 < 0.8`: enough to see what is red without the log.
 * @param {{ parts: { name: string, ok: boolean, detail: string[] }[] }} gate
 */
const redSummary = (gate) =>
  gate.parts
    .filter((p) => !p.ok)
    .map((p) => {
      const first = p.detail.map((d) => d.split('\n')[0].trim()).filter(Boolean).slice(0, 2).join(', ');
      return first ? `${p.name}: ${first.slice(0, 120)}` : p.name;
    })
    .join('; ');

/** @param {{ parts: { name: string, ok: boolean, detail: string[] }[] }} gate */
export const gateFailures = (gate) => gate.parts.filter((p) => !p.ok).flatMap((p) => [p.name, ...p.detail]).join('\n');

/**
 * @typedef {object} LoopOpts
 * @property {string} agent
 * @property {string[]} focuses
 * @property {number} max
 * @property {boolean} [merge]
 * @property {string} [goal]       build this first
 * @property {import('../board/store.js').Task} [task]  claim, note, done/block
 * @property {import('./prompts.js').Handoff} [handoff]
 * @property {import('./prompts.js').Peers} [peers]  parallel run: the other steps building now
 * @property {boolean} [split]     a builder that cannot finish hands the step back to be split (data.split) instead of blocking it
 */

/**
 * Build (optional), then loop until the gate is green and verifiers find nothing.
 * Stops early when stuck: the same failure survives `stuckAfter` fixes, or verifiers revisit a state.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {LoopOpts} opts
 * @returns {Promise<import('../../core/types.js').Result>}
 */
export async function runLoop(ctx, opts) {
  const { root } = ctx;
  let { config } = ctx;
  const { task } = opts;
  const window = config.autopilot.contextWindow;
  const rules = contextRules(window);
  const stuckAfter = config.autopilot.stuckAfter ?? 2;

  /** @param {string} role @param {string} prompt */
  const spawnAgent = async (role, prompt) => {
    const t = opts.task;
    const learned = learnedFor(root, { role, touches: t?.touches ?? [], text: t ? `${t.title}\n${t.body}` : (opts.goal ?? '') });
    const argv = agentArgv(config, opts.agent, prompt + learned.text, { root });
    const r = await runAgent(ctx, argv, role, log, { task: t?.id, learned: learned.ids });
    const output = tail(`${r.stdout}\n${r.stderr}`, 15);
    const overflow = overflowHint(output, config.autopilot);
    log(`${argv[0]} exited ${r.code}\n${output}${overflow ? `\n${overflow}` : ''}`);
    return r;
  };
  /** @param {string} name @param {Record<string, any>} args */
  const onTask = async (name, args) => {
    if (task) await board[name].run({ id: task.id, ...args }, ctx);
  };
  /** @param {string} reason @param {Record<string, unknown>} data */
  const fail = async (reason, data) => {
    recordEvent(root, { type: 'autopilot', ok: false, agent: opts.agent, reason, ...data });
    await onTask('task block', { on: 'human', reason: `autopilot: ${reason}` });
    return { ok: false, summary: `${reason}: a human (or a better environment) is needed`, data };
  };

  const base = git(root, ['rev-parse', 'HEAD']).stdout?.trim() ?? '';
  if (task) {
    const claimed = await board['task claim'].run({ id: task.id, agent: `autopilot:${opts.agent}` }, ctx);
    if (!claimed.ok) return claimed;
  }
  if (opts.goal) {
    log(`builder: ${opts.goal.split('\n')[0]}`);
    let built = await spawnAgent('builder', builderPrompt(config.bin, opts.goal, { handoff: opts.handoff, rules, peers: opts.peers }));
    /** @param {typeof built} r  out of context: a fresh agent with the same step would run out again */
    const ranOut = (r) => r.unfinished === CONTEXT_LOOP || !!overflowHint(tail(`${r.stdout}\n${r.stderr}`, 30), config.autopilot);
    // A green gate after a cut-off builder only proves the half that exists works: finish it first.
    for (let n = 1; built.unfinished && n <= stuckAfter && !(opts.split && ranOut(built)); n++) {
      // Cut off at the output cap: smaller steps cannot help, thinking less can.
      if (built.unfinished === OUTPUT_CAP) {
        const at = built.cutoff ? ` (${built.cutoff} output tokens)` : '';
        if (config.autopilot.thinking === 'off') break;
        log(`builder's replies were cut off at the output limit${at}; retrying with thinking off for the rest of this run`);
        config = { ...config, autopilot: { ...config.autopilot, thinking: 'off' } };
        ctx.config = config;
      }
      log(`builder did not finish (${built.unfinished}); a fresh builder continues it (${n}/${stuckAfter})`);
      await onTask('task note', { note: `autopilot: builder did not finish (${built.unfinished}); continuing (${n}/${stuckAfter})` });
      const resume = { reason: built.unfinished, landed: commitsSince(root, base), dirty: dirtyFiles(root) };
      built = await spawnAgent('builder', builderPrompt(config.bin, opts.goal, { handoff: opts.handoff, rules, resume, peers: opts.peers }));
    }
    if (built.unfinished === OUTPUT_CAP) return fail(`the builder's replies are cut off at ${built.cutoff ? `${built.cutoff} output tokens` : 'the output limit'}${config.autopilot.thinking === 'off' ? ' even with thinking off' : ''}; ${OUTPUT_CAP_FIX}`, { iterations: 0, findings: 0 });
    if (built.unfinished && opts.split) return { ok: false, summary: `the builder did not finish (${built.unfinished})`, data: { split: built.unfinished, context: ranOut(built) } };
    if (built.unfinished) return fail(`the builder did not finish in ${stuckAfter + 1} attempt(s) (last: ${built.unfinished}); split the task or give agents more time (autopilot.agentTimeoutMinutes)`, { iterations: 0, findings: 0 });
    await onTask('task note', { note: `autopilot: builder (${opts.agent}) finished` });
  }

  /** @type {Map<string, number>} */
  const fixes = new Map();
  const seen = new Set();
  let findings = 0;
  /** @type {boolean | undefined} */
  let skipVerifiers;
  /** @param {number} i @param {string} [caveat] */
  const land = async (i, caveat) => {
    // The gate verified the working tree, not HEAD: commit it, or the next builder inherits a dirty tree it has to re-read.
    const left = dirtyFiles(root);
    if (left.length) {
      const title = (task?.title ?? opts.goal?.split('\n')[0] ?? 'autopilot').slice(0, 100);
      git(root, ['add', '-A', '--', '.', ':(exclude).wololo/state']);
      const c = git(root, ['commit', '-q', '--no-verify', '-m', `${title} (autopilot: landed, gate green)`]);
      log(c.status === 0 ? `committed ${left.length} file(s) the agents left uncommitted` : `could not commit what the agents left: ${tail(c.stderr ?? '', 3)}`);
    }
    let merged = '';
    if (opts.merge) {
      const m = await sh(config.autopilot.mergeCommand, { cwd: root });
      merged = m.code === 0 ? 'merged' : `merge failed: ${tail(m.stderr, 5)}`;
    }
    const summary = `landed after ${i} iteration(s), ${findings} verifier finding(s)${caveat ? ` (${caveat})` : ''}${merged ? `; ${merged}` : ''}`;
    recordEvent(root, { type: 'autopilot', ok: true, iterations: i, findings, agent: opts.agent });
    await onTask('task done', { note: `autopilot: ${summary}` });
    return { ok: true, summary, data: { iterations: i, findings } };
  };

  for (let i = 1; i <= opts.max; i++) {
    ctx = refreshConfig(ctx, log);
    config = ctx.config;
    const gate = await runGate(ctx);
    setStatus(root, { gate: gate.ok ? 'green' : `red: ${redSummary(gate)}`, gateAt: new Date().toISOString() });
    count(root, gate.ok ? 'gate green' : 'gate red');
    if (!gate.ok) {
      if (!config.verify.steps.length) return fail(UNVERIFIABLE, { iterations: i, findings });
      const failures = gateFailures(gate);
      const key = failureKey(failures);
      const tried = fixes.get(key) ?? 0;
      if (tried >= stuckAfter) return fail(`stuck: the same gate failure survived ${tried} fix attempt(s)`, { iterations: i, findings });
      fixes.set(key, tried + 1);
      log(`iteration ${i}: gate red (${redSummary(gate)}) → fixer${tried ? ` (retry ${tried})` : ''}`);
      await spawnAgent('fixer', fixerPrompt(config.bin, clip(failures, failureBudget(window)), { retry: tried > 0, rules }));
      continue;
    }
    seen.add(fingerprint(root));
    // Decided once, at the first green gate: later verifier edits must not flip the task into "docs-only".
    skipVerifiers ??= opts.focuses.length > 0 && docsOnly(root, base);
    if (skipVerifiers) log(`iteration ${i}: gate green; docs-only change, skipping verifiers (nothing to fuzz)`);
    let changed = false;
    for (const focus of skipVerifiers ? [] : opts.focuses) {
      const before = fingerprint(root);
      log(`iteration ${i}: gate green → verifier (${focus})`);
      await spawnAgent(`verifier (${focus})`, verifierPrompt(config.bin, focus, base));
      const now = fingerprint(root);
      if (now === before) continue;
      if (seen.has(now)) return fail('stuck: verifiers returned the code to a state already seen (ping-pong)', { iterations: i, findings });
      seen.add(now);
      changed = true;
      findings++;
    }
    if (changed) continue;
    // works and nothing more to fix: hill-climb it against the rubric before it lands
    if (opts.goal) await hillClimb(ctx, { goal: opts.goal, base, rounds: config.autopilot.hillClimb ?? 1, title: (task?.title ?? opts.goal.split('\n')[0]).slice(0, 100), spawn: spawnAgent, log });
    return land(i);
  }
  // Verifiers past --max are still polishing, not blocking: the gate is the merge bar, so a green gate lands.
  const last = await runGate(ctx);
  if (last.ok) return land(opts.max, 'verifiers still finding things');
  return fail(`did not converge in ${opts.max} iterations`, { iterations: opts.max, findings });
}
