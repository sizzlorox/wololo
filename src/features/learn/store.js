import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from '../../core/files.js';
import { overlaps, prefix } from '../autopilot/areas.js';

/**
 * Learned skills: workflows wololo saw agents repeat, written down once and handed only to the
 * agents whose step and role match (never listed to every agent, so they cost no context elsewhere).
 * Committed with the repo in .wololo/learned/<id>/learned.json (+ run.mjs for a script).
 *
 * @typedef {object} Learned
 * @property {string} id
 * @property {string} title
 * @property {'skill' | 'script'} kind
 * @property {string} body        instructions; {{script}} stands for the command that runs run.mjs
 * @property {{ roles: string[], files: string[] }} trigger  empty = any
 * @property {'trial' | 'kept' | 'retired'} status
 * @property {string} [reason]   why it was kept or retired
 * @property {{ calls: string[], runs: string[], tasks: string[], baselineTurns: number }} evidence
 * @property {string} created
 * @property {string} [decided]
 */

/** Most learned skills handed to one agent, and the longest body: they share its context. */
export const MAX_PER_AGENT = 3;
export const MAX_BODY = 1500;
/** Matched runs needed to judge a trial; agent runs in a matching role after which a skill that never fired is retired. */
const JUDGE_AFTER = 3;
const NEVER_AFTER = 15;

/**
 * Always the main repo's: a parallel worker's worktree was branched before newer skills existed.
 * @param {string} root
 */
export const learnedDir = (root) => join(process.env.WOLOLO_CONFIG ? dirname(process.env.WOLOLO_CONFIG) : root, '.wololo', 'learned');

/**
 * @param {string} root
 * @param {boolean} [own]  this checkout's skills (for sync), not the main repo's
 * @returns {Learned[]}
 */
export function listLearned(root, own = false) {
  const dir = own ? join(root, '.wololo', 'learned') : learnedDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((id) => readJson(join(dir, id, 'learned.json'), /** @type {Learned | null} */ (null)))
    .filter((x) => x !== null)
    .sort((a, b) => a.created.localeCompare(b.created));
}

/** @param {string} root @param {Learned} item */
export const saveLearned = (root, item) => writeJson(join(learnedDir(root), item.id, 'learned.json'), item);

/** @param {string} root @param {string} id */
export const removeLearned = (root, id) => rmSync(join(learnedDir(root), id), { recursive: true, force: true });

/** builder, fixer, verifier (…), from a run's role label. @param {string} role */
export const baseRole = (role) => role.split(/ [(·]/)[0].trim();

/**
 * Does a learned skill apply to this agent?
 * @param {Learned} item
 * @param {{ role: string, touches: string[], text: string }} at  the agent's role, its step's areas and text
 */
export function matches(item, at) {
  if (item.status === 'retired') return false;
  const { roles, files } = item.trigger;
  if (roles.length && !roles.includes(baseRole(at.role))) return false;
  if (!files.length) return true;
  return (at.touches.length > 0 && overlaps(at.touches, files)) || files.some((f) => prefix(f) && at.text.replace(/\\/g, '/').includes(prefix(f)));
}

/** @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Judge a trial from the agent runs since it was adopted. Kept when the runs it was handed to took
 * fewer turns than the runs it was learned from; retired when they did not, or when it never fired.
 * ponytail: turns across different steps is a rough measure; compare per role and step size if it misjudges
 * @param {Learned} item
 * @param {{ role: string, ts: string, turns: number, learned?: string[] }[]} runs  agent runs, any order
 * @returns {{ status: 'kept' | 'retired', reason: string } | undefined}
 */
export function decide(item, runs) {
  if (item.status !== 'trial') return undefined;
  const since = runs.filter((r) => String(r.ts) >= item.created);
  const matched = since.filter((r) => r.learned?.includes(item.id) && r.turns > 0);
  if (matched.length >= JUDGE_AFTER) {
    const now = median(matched.map((r) => r.turns));
    const before = item.evidence.baselineTurns;
    if (!before || now < before) return { status: 'kept', reason: `matched runs took ${now} turns (median) vs ${before || '?'} before` };
    return { status: 'retired', reason: `no gain: matched runs took ${now} turns (median) vs ${before} before` };
  }
  const eligible = since.filter((r) => !item.trigger.roles.length || item.trigger.roles.includes(baseRole(r.role)));
  if (!matched.length && eligible.length >= NEVER_AFTER) return { status: 'retired', reason: `never matched in ${eligible.length} agent runs` };
  return undefined;
}

/**
 * The learned skills for one agent, as prompt text, and their ids (recorded with its usage).
 * @param {string} root
 * @param {{ role: string, touches?: string[], text?: string }} at
 */
export function learnedFor(root, at) {
  const picked = listLearned(root)
    .filter((i) => matches(i, { role: at.role, touches: at.touches ?? [], text: at.text ?? '' }))
    .sort((a, b) => (a.status === 'kept' ? 0 : 1) - (b.status === 'kept' ? 0 : 1))
    .slice(0, MAX_PER_AGENT);
  if (!picked.length) return { text: '', ids: [] };
  const dir = learnedDir(root);
  const text = [
    '',
    'Learned in this repo from earlier agents (use it instead of working it out again):',
    ...picked.map((i) => `\n### ${i.title}\n${i.body.slice(0, MAX_BODY).replaceAll('{{script}}', `node "${join(dir, i.id, 'run.mjs').replace(/\\/g, '/')}"`)}`),
  ].join('\n');
  return { text, ids: picked.map((i) => i.id) };
}
