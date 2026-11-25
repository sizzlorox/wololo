import { join } from 'node:path';
import { appendJsonl, readJsonl } from './files.js';

// Canonical layout. Everything the harness owns lives under `.wololo/`.
export const WOLOLO_DIR = '.wololo';
export const CONFIG_FILE = 'wololo.config.json';
export const MANIFEST_FILE = '.wololo/generated.json';

/** @param {string} root @param {...string} parts */
export const wololoPath = (root, ...parts) => join(root, WOLOLO_DIR, ...parts);

/**
 * Local, gitignored runtime state (queue, board, events, reviews). A parallel autopilot worker runs
 * in its own git worktree with WOLOLO_STATE pointing at the main repo's state, so all agents share one board.
 * @param {string} root @param {...string} parts
 */
export const statePath = (root, ...parts) => join(process.env.WOLOLO_STATE || join(root, WOLOLO_DIR, 'state'), ...parts);

/**
 * @typedef {object} WololoEvent
 * @property {string} ts
 * @property {string} type   verify | gate | check | hook | score | autopilot
 * @property {boolean} [ok]
 */

/**
 * The single telemetry log. Trust, bottleneck and garden all read from here.
 * @param {string} root
 * @param {Record<string, unknown> & { type: string }} event
 */
export function recordEvent(root, event) {
  appendJsonl(statePath(root, 'events.jsonl'), { ts: new Date().toISOString(), ...event });
}

/**
 * @param {string} root
 * @param {string} [type]
 * @returns {any[]}
 */
export function readEvents(root, type) {
  const all = readJsonl(statePath(root, 'events.jsonl'));
  return type ? all.filter((e) => e.type === type) : all;
}
