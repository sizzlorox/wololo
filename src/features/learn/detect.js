/**
 * Find workflows agents keep repeating, from the recorded tool calls of past runs. Deterministic:
 * no agent decides what counts as a pattern.
 *
 * @typedef {{ id: string, role: string, task?: string, calls: string[], turns?: number }} RunCalls
 * @typedef {{ key: string, calls: string[], runs: string[], tasks: string[], roles: string[] }} Pattern
 */

/**
 * One tool call as a comparable line: tool and target, with machine-specific parts folded away.
 * @param {string} tool @param {string} args  the call's arguments, usually JSON
 * @param {string[]} [roots]  repo roots to strip from paths
 */
export function normalizeCall(tool, args, roots = []) {
  let a;
  try {
    a = JSON.parse(args);
  } catch {
    a = args;
  }
  const raw = typeof a === 'string' ? a : (a?.command ?? a?.path ?? a?.file_path ?? a?.pattern ?? a?.query ?? a?.url ?? JSON.stringify(a ?? ''));
  let t = String(raw).replace(/\\\\/g, '/').replace(/\\/g, '/');
  t = t.replace(/[A-Za-z]:\/[^\s'"]*?-wololo-worktrees\/[^/\s'"]+\//g, ''); // a parallel worktree
  for (const r of roots) t = t.split(`${r.replace(/\\/g, '/').replace(/\/+$/, '')}/`).join('');
  t = t
    .replace(/^cd\s+\S+\s*(&&|;)\s*/, '')
    .replace(/:\d+(-\d+)?\b/g, '') // read ranges
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${tool.toLowerCase()}: ${t}`;
}

/** wololo's own commands are the process itself, not something to learn. */
const OWN = /\bwololo\b|\btask note\b/;

/**
 * Sequences of 1 (shell commands only) to `maxLen` calls that occur in at least `minRuns` runs
 * spanning at least `minTasks` steps. A sequence inside a longer one with the same runs is dropped.
 * @param {RunCalls[]} runs
 * @param {{ minRuns?: number, minTasks?: number, maxLen?: number }} [opts]
 * @returns {Pattern[]} most widespread first
 */
export function detect(runs, opts = {}) {
  const { minRuns = 3, minTasks = 2, maxLen = 4 } = opts;
  /** @type {Map<string, { calls: string[], runs: Set<string>, tasks: Set<string>, roles: Set<string> }>} */
  const grams = new Map();
  for (const r of runs) {
    const calls = r.calls.filter((c) => !OWN.test(c));
    const here = new Set();
    for (let n = 1; n <= maxLen; n++) {
      for (let i = 0; i + n <= calls.length; i++) {
        const seq = calls.slice(i, i + n);
        if (n === 1 && !/^(bash|shell|powershell): /.test(seq[0])) continue; // a lone read or edit is ordinary work
        if (new Set(seq).size < n) continue; // the same call twice in a row is circling, not a workflow
        const key = seq.join('\n');
        if (here.has(key)) continue;
        here.add(key);
        const g = grams.get(key) ?? { calls: seq, runs: new Set(), tasks: new Set(), roles: new Set() };
        g.runs.add(r.id);
        g.tasks.add(r.task ?? r.id);
        g.roles.add(r.role);
        grams.set(key, g);
      }
    }
  }
  const found = [...grams].filter(([, g]) => g.runs.size >= minRuns && g.tasks.size >= minTasks);
  const contains = (/** @type {string[]} */ big, /** @type {string[]} */ small) => big.length > small.length && big.some((_, i) => small.every((c, j) => big[i + j] === c));
  return found
    .filter(([, g]) => !found.some(([, o]) => contains(o.calls, g.calls) && o.runs.size === g.runs.size))
    .map(([key, g]) => ({ key, calls: g.calls, runs: [...g.runs], tasks: [...g.tasks], roles: [...g.roles] }))
    .sort((a, b) => b.runs.length * b.calls.length - a.runs.length * a.calls.length);
}
