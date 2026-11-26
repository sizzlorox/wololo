import { git } from './git.js';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readJson } from './files.js';
import { loadSchema, validate } from './schema.js';
import { CONFIG_FILE } from './state.js';

/** Context windows (tokens) below this get slim agents: fewer tools, skills and MCP tools. */
export const SMALL_WINDOW = 65536;
/** @param {number | undefined} contextWindow */
export const isSmallWindow = (contextWindow) => Boolean(contextWindow && contextWindow < SMALL_WINDOW);
/** MCP tools served by default on a small window (override with mcp.tools). */
export const SMALL_WINDOW_MCP_TOOLS = ['gate', 'verify', 'check', 'task note', 'queue add'];
/**
 * The MCP allowlist for this config: mcp.tools, else the small-window default, else every tool (undefined).
 * @param {{ mcp?: { tools?: string[] }, autopilot: { contextWindow?: number } }} config
 */
export const mcpTools = (config) => config.mcp?.tools ?? (isSmallWindow(config.autopilot.contextWindow) ? SMALL_WINDOW_MCP_TOOLS : undefined);

export const HARNESSES = /** @type {const} */ (['claude', 'codex', 'copilot', 'cursor', 'gemini', 'windsurf', 'opencode', 'amp', 'aider', 'cline', 'omp']);

/**
 * @typedef {{ name: string, run: string, fast?: boolean, timeoutSec?: number }} VerifyStep
 * @typedef {{ name: string, run: string, kind?: string, fields?: Record<string, string> }} Source
 *
 * @typedef {object} Config
 * @property {string} project
 * @property {string} bin
 * @property {string[]} harnesses
 * @property {string[]} ignore
 * @property {{ steps: VerifyStep[], timeoutSec: number }} verify
 * @property {{ minScore: number, requireJudgment: boolean }} gate
 * @property {{ agent: string, command?: string[], verifiers: number, maxIterations: number, workers?: number, models?: Record<string, string>, learn?: 'auto' | 'suggest' | 'off', hillClimb?: number, protectedBranches?: string[], mergeCommand: string, contextWindow?: number, stuckAfter?: number, agentTimeoutMinutes?: number, stallMinutes?: number, gapRounds?: number, thinking?: string }} autopilot
 * @property {{ tools?: string[] }} [mcp]
 * @property {Source[]} sources
 * @property {{ provider: 'github' | 'none', setup: string[] }} ci
 */

/** @param {string} root @returns {Config} */
export function defaultConfig(root) {
  return {
    project: basename(root),
    bin: 'npx --no-install wololo',
    harnesses: [...HARNESSES],
    ignore: ['.git/**', '**/node_modules/**', 'dist/**', 'build/**', 'coverage/**', 'vendor/**', '.venv/**', 'target/**'],
    verify: { steps: [], timeoutSec: 900 },
    gate: { minScore: 0.8, requireJudgment: false },
    autopilot: { agent: 'claude', verifiers: 1, maxIterations: 5, mergeCommand: 'gh pr merge --auto --squash', workers: 1 },
    sources: [],
    ci: { provider: 'github', setup: [] },
  };
}

/**
 * Root = nearest dir with wololo.config.json, else git toplevel, else cwd.
 * @param {string} cwd
 */
export function findRoot(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return { root: dir, hasConfig: true };
    if (process.env.WOLOLO_CONFIG && dir === resolve(cwd)) {
      // a parallel worker's worktree: the main repo's config applies
      const top = git(cwd, ['rev-parse', '--show-toplevel']);
      if (top.status === 0) return { root: resolve(top.stdout.trim()), hasConfig: true };
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return { root: top.status === 0 ? top.stdout.trim() : resolve(cwd), hasConfig: false };
}

/**
 * @param {string} root
 * @returns {Config}
 */
export function loadConfig(root) {
  const base = defaultConfig(root);
  const raw = readJson(existsSync(join(root, CONFIG_FILE)) ? join(root, CONFIG_FILE) : process.env.WOLOLO_CONFIG || join(root, CONFIG_FILE), /** @type {any} */ ({}));
  const errors = validate(loadSchema('wololo.config'), raw);
  if (errors.length) throw new Error(`Invalid ${CONFIG_FILE}:\n  ${errors.join('\n  ')}`);
  return {
    ...base,
    ...raw,
    verify: { ...base.verify, ...raw.verify },
    gate: { ...base.gate, ...raw.gate },
    autopilot: { ...base.autopilot, ...raw.autopilot },
    ci: { ...base.ci, ...raw.ci },
  };
}
