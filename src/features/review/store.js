import { readJson, writeJson } from '../../core/files.js';
import { statePath } from '../../core/state.js';

/**
 * @typedef {object} Review
 * @property {string} sha
 * @property {string} subject
 * @property {string} author
 * @property {string} date
 * @property {'pending' | 'ok' | 'fix-env' | 'revert'} status
 * @property {string} [note]
 * @property {string} sampledAt
 * @property {string} [reviewedAt]
 */

/** @param {string} root @returns {{ cursor?: string, items: Review[] }} */
export function readReviews(root) {
  return readJson(statePath(root, 'reviews.json'), { items: [] });
}

/** @param {string} root @param {{ cursor?: string, items: Review[] }} state */
export function writeReviews(root, state) {
  writeJson(statePath(root, 'reviews.json'), state);
}

/**
 * Stable, seedless sampling: a commit is picked iff its hash falls under the rate.
 * The same commit always gets the same answer, so re-running never reshuffles.
 * @param {string} sha
 * @param {number} rate
 */
export function sampled(sha, rate) {
  return parseInt(sha.slice(0, 8), 16) / 0xffffffff < rate;
}
