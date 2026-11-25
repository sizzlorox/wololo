import { closeSync, openSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, readJson, writeJson } from '../../core/files.js';
import { statePath } from '../../core/state.js';

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} group
 * @property {string} body
 * @property {'todo' | 'claimed' | 'blocked' | 'done'} status
 * @property {string} [agent]
 * @property {string} [blockedOn]   Who/what is needed. "human" counts toward the bottleneck report.
 * @property {string[]} queue
 * @property {string[]} notes
 * @property {number} [seq]       Position in a plan (autopilot --plan builds tasks in this order).
 * @property {string} [goal]      The plan's overall goal, handed to each fresh builder.
 * @property {number} [splitDepth] How many times autopilot split the step this one came from.
 * @property {string[]} [splitInto]  Set when autopilot replaced this step with smaller ones (it is then done).
 * @property {string[]} [deps]     Task ids this step needs landed first (parallel autopilot).
 * @property {string[]} [touches]  Paths or dirs this step will change; steps that overlap never run at once.
 * @property {string} created
 * @property {string} updated
 */

/** @param {string} root */
const dir = (root) => statePath(root, 'board');

/** @param {string} root @returns {Task[]} */
export function readTasks(root) {
  let names = [];
  try {
    names = readdirSync(dir(root)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readJson(join(dir(root), n), /** @type {any} */ (null))).filter(Boolean).sort((a, b) => a.created.localeCompare(b.created));
}

/** @param {string} root @param {string} id @returns {Task | undefined} */
export function readTask(root, id) {
  return readJson(join(dir(root), `${id}.json`), undefined);
}

/** @param {string} root @param {Task} task */
export function writeTask(root, task) {
  writeJson(join(dir(root), `${task.id}.json`), { ...task, updated: new Date().toISOString() });
}

/**
 * Atomic claim via O_EXCL lockfile: two agents can never own the same task.
 * @param {string} root
 * @param {string} id
 */
export function lock(root, id) {
  ensureDir(dir(root));
  try {
    closeSync(openSync(join(dir(root), `${id}.lock`), 'wx'));
    return true;
  } catch {
    return false;
  }
}

/** @param {string} root @param {string} id */
export function unlock(root, id) {
  rmSync(join(dir(root), `${id}.lock`), { force: true });
}

/** Delete a task and its lock. @param {string} root @param {string} id */
export function removeTask(root, id) {
  rmSync(join(dir(root), `${id}.json`), { force: true });
  unlock(root, id);
}
