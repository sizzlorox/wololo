import { spawnSync } from '../../core/proc.js';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, sh } from '../../core/exec.js';
import { readJson, writeJson } from '../../core/files.js';
import { CONFIG_FILE } from '../../core/state.js';
import { templatePath } from '../../core/templates.js';
import { agentArgv } from '../autopilot/argv.js';

export const WOLOLO_BIN = fileURLToPath(new URL('../../../bin/wololo.js', import.meta.url));

/** Arms, cheapest first. `bare` is the control: same repo, same agent, same prompt, no wololo. */
export const ARMS = /** @type {const} */ (['bare', 'wololo', 'autopilot']);

// A nested `node --test` that inherits this would report to our runner and always exit 0.
const CLEAN_ENV = { NODE_TEST_CONTEXT: undefined };

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/;

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** @param {string} ws @param {string} message */
function commitAll(ws, message) {
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-q', '--allow-empty', '--no-verify', '-m', message]);
  return git(ws, ['rev-parse', 'HEAD']).stdout.trim();
}

/**
 * Last "N passed / N failed" style counts in test output (node:test, TAP, jest, vitest, pytest). Falls back to the exit code.
 * @param {string} out
 * @param {boolean} ok
 */
export function hiddenFraction(out, ok) {
  /** @param {RegExp} re */
  const last = (re) => {
    const m = [...out.matchAll(re)].at(-1);
    return m ? Number(m[1]) : undefined;
  };
  const pass = last(/^\s*(?:#|ℹ)\s*pass\s+(\d+)/gm) ?? last(/(\d+) passed/g);
  const fail = last(/^\s*(?:#|ℹ)\s*fail\s+(\d+)/gm) ?? last(/(\d+) failed/g) ?? 0;
  if (pass === undefined || pass + fail === 0) return ok ? 1 : 0;
  return pass / (pass + fail);
}

/** @param {string} out */
export function parseCost(out) {
  const m = [...out.matchAll(/"(?:total_cost_usd|cost_usd)"\s*:\s*([\d.]+)/g)].at(-1);
  return m ? Number(m[1]) : null;
}

/** @param {string} ws */
const cleanup = (ws) => rmSync(ws, { recursive: true, force: true });

/**
 * @typedef {object} TrialOpts
 * @property {import('../../core/config.js').Config} config  host config (decides how the agent is launched)
 * @property {string} agent
 * @property {string} harness   which adapter `wololo init` wires in the workspace
 * @property {number} timeoutMs
 * @property {boolean} [keep]
 */

/**
 * A fresh git repo with the task's starting code; for wololo arms, the harness installed and committed.
 * @param {import('./suite.js').BenchTask} task
 * @param {string} arm
 * @param {TrialOpts} opts
 */
export async function prepare(task, arm, opts) {
  const ws = mkdtempSync(join(tmpdir(), `wololo-bench-${task.id}-${arm}-`));
  cpSync(join(task.dir, 'repo'), ws, { recursive: true });
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.name', 'wololo-bench']);
  git(ws, ['config', 'user.email', 'bench@wololo.invalid']);
  git(ws, ['config', 'commit.gpgsign', 'false']);
  if (task.setup) {
    const s = await sh(task.setup, { cwd: ws, timeoutMs: opts.timeoutMs, env: CLEAN_ENV });
    if (s.code !== 0) throw new Error(`${task.id}: setup failed: ${s.stderr.slice(-500)}`);
  }
  commitAll(ws, 'bench: starting code');
  if (arm !== 'bare') {
    const bin = WOLOLO_BIN.includes(' ') ? `node "${WOLOLO_BIN}"` : `node ${WOLOLO_BIN}`;
    const init = await run([process.execPath, WOLOLO_BIN, 'init', '--yes', '--ci', 'none', '--harness', opts.harness, '--bin', bin], { cwd: ws, env: { ...CLEAN_ENV, CI: '1' } });
    if (init.code !== 0) throw new Error(`${task.id}: wololo init failed: ${init.stdout}${init.stderr}`);
    const cfg = readJson(join(ws, CONFIG_FILE), /** @type {any} */ ({}));
    cfg.autopilot = { ...cfg.autopilot, agent: opts.agent, ...(opts.config.autopilot.command ? { command: opts.config.autopilot.command } : {}) };
    writeJson(join(ws, CONFIG_FILE), cfg);
    commitAll(ws, 'bench: wololo init');
  }
  return { ws, base: git(ws, ['rev-parse', 'HEAD']).stdout.trim() };
}

/**
 * Copy the hidden tests in and run the task's check.
 * @param {import('./suite.js').BenchTask} task
 * @param {string} ws
 * @param {number} timeoutMs
 */
export async function runHidden(task, ws, timeoutMs) {
  rmSync(join(ws, 'hidden'), { recursive: true, force: true });
  if (existsSync(join(task.dir, 'hidden'))) cpSync(join(task.dir, 'hidden'), join(ws, 'hidden'), { recursive: true });
  const r = await sh(task.check, { cwd: ws, timeoutMs, env: CLEAN_ENV });
  const out = `${r.stdout}\n${r.stderr}`;
  return { pass: r.code === 0, hidden: hiddenFraction(out, r.code === 0), out };
}

/**
 * Rule violations in files the agent touched, using the default rule set in every arm so the arms are scored alike.
 * @param {string} ws
 * @param {string[]} files
 */
async function violationsIn(ws, files) {
  if (!files.length) return 0;
  if (!existsSync(join(ws, '.wololo', 'rules'))) cpSync(templatePath('rules'), join(ws, '.wololo', 'rules'), { recursive: true });
  const r = await run([process.execPath, WOLOLO_BIN, 'check', '--json', ...files], { cwd: ws });
  try {
    return JSON.parse(r.stdout).data.violations.length;
  } catch {
    return 0;
  }
}

/**
 * One task × arm × trial, end to end, in a throwaway workspace.
 * @param {import('./suite.js').BenchTask} task
 * @param {string} arm
 * @param {number} trial
 * @param {TrialOpts} opts
 * @returns {Promise<import('./stats.js').Trial & { workspace?: string, agentExit: number }>}
 */
export async function runTrial(task, arm, trial, opts) {
  const timeoutMs = (task.timeoutMin ? task.timeoutMin * 60_000 : 0) || opts.timeoutMs;
  const { ws, base } = await prepare(task, arm, { ...opts, timeoutMs });
  try {
    const argv =
      arm === 'autopilot'
        ? [process.execPath, WOLOLO_BIN, 'autopilot', '--goal', task.prompt, '--agent', opts.agent]
        : agentArgv(opts.config, opts.agent, task.prompt);
    const agent = await run(argv, { cwd: ws, timeoutMs, env: CLEAN_ENV });
    const head = commitAll(ws, 'bench: agent work');
    const changed = git(ws, ['diff', '--name-only', '--diff-filter=AM', base, head]).stdout.split('\n').filter(Boolean);
    const lines = git(ws, ['diff', '--numstat', base, head])
      .stdout.split('\n')
      .map((l) => l.split('\t'))
      .reduce((sum, [a, d]) => sum + (Number(a) || 0) + (Number(d) || 0), 0);
    const violations = await violationsIn(ws, changed);
    const hidden = await runHidden(task, ws, Math.max(timeoutMs, 60_000));
    return {
      task: task.id,
      arm,
      trial,
      pass: hidden.pass,
      hidden: hidden.hidden,
      violations,
      tests: changed.filter((f) => TEST_FILE.test(f)).length,
      lines,
      ms: agent.ms,
      timedOut: agent.timedOut,
      costUsd: parseCost(agent.stdout),
      changed,
      agentExit: agent.code,
      ...(opts.keep ? { workspace: ws } : {}),
    };
  } finally {
    if (!opts.keep) cleanup(ws);
  }
}

/**
 * A task is only a measurement if its hidden check can fail: it must fail on the starting code
 * and (when a reference solution is given) pass with it.
 * @param {import('./suite.js').BenchTask} task
 * @param {TrialOpts} opts
 * @returns {Promise<string[]>} problems
 */
export async function validateTask(task, opts) {
  const { ws } = await prepare(task, 'bare', opts);
  try {
    /** @type {string[]} */
    const problems = [];
    if (!existsSync(join(task.dir, 'hidden'))) problems.push('no hidden/ tests');
    const before = await runHidden(task, ws, opts.timeoutMs);
    if (before.pass) problems.push('hidden check passes before any change: it cannot measure anything');
    if (existsSync(join(task.dir, 'solution'))) {
      cpSync(join(task.dir, 'solution'), ws, { recursive: true });
      const after = await runHidden(task, ws, opts.timeoutMs);
      if (!after.pass) problems.push(`hidden check fails with the reference solution:\n${after.out.trim().split('\n').slice(-15).join('\n')}`);
    }
    return problems;
  } finally {
    cleanup(ws);
  }
}
