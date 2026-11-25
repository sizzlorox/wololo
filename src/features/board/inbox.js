import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { ensureDir } from '../../core/files.js';
import { statePath } from '../../core/state.js';

/**
 * One message stream per board group, so agents building a plan in parallel hear each other.
 * Written by `task note` and the parallel orchestrator; read by the peer hook (autopilot/peers/peers.cjs)
 * after every tool call, and by the TUI.
 *
 * @typedef {{ at: string, from: string, title: string, text: string }} Message  from: a task id, or "wololo"
 */

/** @param {string} root @param {string} group */
export const inboxPath = (root, group) => statePath(root, 'inbox', `${group}.jsonl`);

/** @param {string} root @param {string} group @param {Omit<Message, 'at'>} msg */
export function post(root, group, msg) {
  ensureDir(statePath(root, 'inbox'));
  appendFileSync(inboxPath(root, group), `${JSON.stringify({ at: new Date().toISOString(), ...msg })}\n`);
}

/** @param {string} root @param {string} group @returns {Message[]} */
export function messages(root, group) {
  const file = inboxPath(root, group);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}
