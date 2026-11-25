import aider from './aider.js';
import amp from './amp.js';
import claude from './claude.js';
import cline from './cline.js';
import codex from './codex.js';
import copilot from './copilot.js';
import cursor from './cursor.js';
import gemini from './gemini.js';
import omp from './omp.js';
import opencode from './opencode.js';
import windsurf from './windsurf.js';

/** The adapter registry. Adding a harness = one file + one line here. */
/** @type {Record<string, import('./types.js').Adapter>} */
export const ADAPTERS = { claude, codex, copilot, cursor, gemini, windsurf, opencode, amp, aider, cline, omp };

/**
 * Pick the fewest skill directories that every enabled harness can read (greedy set cover).
 * @param {import('./types.js').Adapter[]} adapters
 */
export function chooseSkillDirs(adapters) {
  let uncovered = adapters.filter((a) => a.skillDirs.length);
  /** @type {string[]} */
  const chosen = [];
  while (uncovered.length) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const a of uncovered) for (const d of a.skillDirs) counts.set(d, (counts.get(d) ?? 0) + 1);
    const best = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    chosen.push(best);
    uncovered = uncovered.filter((a) => !a.skillDirs.includes(best));
  }
  return chosen;
}
