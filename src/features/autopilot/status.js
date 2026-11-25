import { join } from 'node:path';
import { readJson, writeText } from '../../core/files.js';
import { statePath } from '../../core/state.js';

/** A parallel worker writes its own status; the orchestrator owns autopilot.json. */
const FILE = process.env.WOLOLO_WORKER ? join('workers', `${process.env.WOLOLO_WORKER}.json`) : 'autopilot.json';
const KEEP = 60;

/**
 * What a running autopilot is doing, written to .wololo/state/autopilot.json for `wololo watch`.
 * @typedef {object} Status
 * @property {number} pid
 * @property {string} started
 * @property {'running' | 'landed' | 'stopped'} state
 * @property {string} [goal]
 * @property {string} [group]
 * @property {string} [agentCli]  the agent harness autopilot drives (omp, claude, …)
 * @property {string} [model]     the model the latest agent reported
 * @property {number} [workers]   autopilot.workers when the run started (1 = one step at a time)
 * @property {string} [version]   wololo's version
 * @property {number} [stallMinutes]
 * @property {{ id: string, title: string, started?: string }} [task]
 * @property {string} [phase]       e.g. "iteration 2: gate red → fixer"
 * @property {string} [gate]        latest gate verdict, one line
 * @property {string} [gateAt]      when it was decided
 * @property {AgentRun | null} [agent]
 * @property {Record<string, number>} [stats]  run counters: agent runs by role, `gate green`/`gate red`, `killed: <why>`, `landed`, `landedMs`, `split`, `stopped`
 * @property {number} [contextWindow]
 * @property {{ at: string, line: string }[]} activity
 * @property {string} [summary]     how the run ended
 * @property {{ workers: number, main: string, running: { id: string, title: string, started: string, dir: string }[], queue: { id: string, title: string, state: string }[] }} [parallel]  set while steps build in parallel
 */

/**
 * The agent running now.
 * @typedef {object} AgentRun
 * @property {string} role
 * @property {string} started
 * @property {number} timeoutMinutes
 * @property {string} base        HEAD when it started
 * @property {number} [tokens]    context in use after its latest turn
 * @property {number} [calls]     tool calls
 * @property {number} [edits]     tool calls that edit files
 * @property {number} [compactions]
 * @property {string} [idleSince] last real progress (work output or a file change)
 * @property {string} [error]     the latest model-server error line
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, turns: number }} [usage]  tokens spent so far
 * @property {string} [transcript]  run id under .wololo/state/runs
 * @property {string} [live]       the block the model is streaming right now (tail)
 * @property {'thinking' | 'reply'} [liveOf]
 */

/**
 * Each process's status, keyed by the status file it writes. Keyed by file, not by repo root: an agent
 * run in a parallel worktree (a merger) has the worktree as its root but writes the main repo's file,
 * and must update the run's status rather than replace it (that lost the plan, and with it resume).
 * @type {Map<string, Status>}
 */
const live = new Map();
/** @param {string} root */
const slot = (root) => statePath(root, FILE);

/**
 * @param {string} root
 * @param {string} [worker]  a parallel worker's task id: its own status
 * @returns {Status | null}
 */
export const readStatus = (root, worker) => readJson(statePath(root, worker ? join('workers', `${worker}.json`) : FILE), null);

/** @param {string} file @param {Partial<Status>} patch */
function update(file, patch) {
  const cur = live.get(file) ?? { pid: process.pid, started: new Date().toISOString(), state: 'running', activity: [] };
  const next = { ...cur, ...patch };
  live.set(file, next);
  try {
    writeText(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // the status file is a display: a failed write must never stop the run (the next write catches up)
  }
}

/**
 * Merge into this process's status and write it out. Cheap enough to call on every activity line.
 * @param {string} root
 * @param {Partial<Status>} patch
 */
export const setStatus = (root, patch) => update(slot(root), patch);

/** Start a fresh status for a new run. @param {string} root @param {Partial<Status>} patch */
export function startStatus(root, patch) {
  live.delete(slot(root));
  setStatus(root, { ...patch, activity: [] });
}

/** @param {string} file @param {string} line */
function activity(file, line) {
  update(file, { activity: [...(live.get(file)?.activity ?? []), { at: new Date().toISOString(), line }].slice(-KEEP) });
}

/** @param {string} root @param {string} line */
export const addActivity = (root, line) => activity(slot(root), line);

/** An autopilot log line, shown in `watch` alongside agent activity. @param {string} line */
export function noteEverywhere(line) {
  const first = line.split('\n')[0];
  for (const file of live.keys()) {
    activity(file, `» ${first}`);
    if (!/still running/.test(first)) update(file, { phase: first });
  }
}

/**
 * Add to a run counter, e.g. `count(root, 'gate red')`.
 * @param {string} root
 * @param {string} key
 * @param {number} [by]
 */
export function count(root, key, by = 1) {
  const stats = { ...live.get(slot(root))?.stats };
  stats[key] = (stats[key] ?? 0) + by;
  setStatus(root, { stats });
}
