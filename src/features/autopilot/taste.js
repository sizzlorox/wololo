import { sampleCommits } from '../review/command.js';

/**
 * Sample instead of blocking: after a step lands, put a share of its commits up for the human to
 * taste (the trust ladder's rate, never zero). Shown on the TUI's Review tab.
 * @param {string} root @param {(msg: string) => void} log
 */
export function tasteSample(root, log) {
  try {
    const r = sampleCommits(root);
    if (r.picked.length) log(`sampled ${r.picked.length} commit(s) to review (${Math.round(r.rate * 100)}% at this trust level): Review tab`);
  } catch (e) {
    log(`could not sample commits for review: ${/** @type {Error} */ (e).message}`);
  }
}
