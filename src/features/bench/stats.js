/**
 * Wilson score interval for a binomial proportion: honest at small n, never leaves [0, 1].
 * @param {number} k successes
 * @param {number} n trials
 * @param {number} [z]
 * @returns {[number, number]}
 */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Newcombe's hybrid interval for the difference of two proportions (treatment minus control).
 * @param {number} k1 @param {number} n1 @param {number} k0 @param {number} n0
 * @returns {[number, number]}
 */
export function diffInterval(k1, n1, k0, n0) {
  const [l1, u1] = wilson(k1, n1);
  const [l0, u0] = wilson(k0, n0);
  const p1 = n1 ? k1 / n1 : 0;
  const p0 = n0 ? k0 / n0 : 0;
  const d = p1 - p0;
  return [d - Math.sqrt((p1 - l1) ** 2 + (u0 - p0) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p0 - l0) ** 2)];
}

/** @param {number[]} xs */
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * @typedef {object} Trial
 * @property {string} task
 * @property {string} arm
 * @property {number} trial
 * @property {boolean} pass
 * @property {number} hidden      fraction of hidden tests passing (0..1)
 * @property {number} violations  rule errors+warnings in files the agent changed
 * @property {number} tests       test files the agent added or changed
 * @property {number} lines       lines added + removed
 * @property {number} ms
 * @property {boolean} timedOut
 * @property {number | null} costUsd
 * @property {string[]} changed
 */

/**
 * @param {Trial[]} results
 * @param {string[]} arms  in display order; the first is the baseline
 */
export function summarize(results, arms) {
  const base = results.filter((r) => r.arm === arms[0]);
  const kb = base.filter((r) => r.pass).length;
  const rows = arms.map((arm) => {
    const rs = results.filter((r) => r.arm === arm);
    const k = rs.filter((r) => r.pass).length;
    const costs = rs.map((r) => r.costUsd).filter((c) => typeof c === 'number');
    const isBase = arm === arms[0];
    return {
      arm,
      n: rs.length,
      passes: k,
      passRate: rs.length ? k / rs.length : 0,
      ci: wilson(k, rs.length),
      delta: isBase || !rs.length ? null : k / rs.length - (base.length ? kb / base.length : 0),
      deltaCi: isBase || !rs.length || !base.length ? null : diffInterval(k, rs.length, kb, base.length),
      hidden: mean(rs.map((r) => r.hidden)),
      violations: mean(rs.map((r) => r.violations)),
      tests: mean(rs.map((r) => r.tests)),
      lines: mean(rs.map((r) => r.lines)),
      ms: mean(rs.map((r) => r.ms)),
      timeouts: rs.filter((r) => r.timedOut).length,
      costUsd: costs.length ? mean(/** @type {number[]} */ (costs)) : null,
    };
  });
  const tasks = [...new Set(results.map((r) => r.task))].map((task) => ({
    task,
    arms: Object.fromEntries(arms.map((arm) => {
      const rs = results.filter((r) => r.task === task && r.arm === arm);
      return [arm, `${rs.filter((r) => r.pass).length}/${rs.length}`];
    })),
  }));
  return { arms: rows, tasks };
}

/** @param {number} x */
const pct = (x) => `${Math.round(x * 100)}%`;
/** @param {number} ms */
const dur = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

/** @param {ReturnType<typeof summarize>} s */
export function formatReport(s) {
  const head = ['arm', 'n', 'pass', '95% CI', 'Δ vs ' + (s.arms[0]?.arm ?? 'base'), 'hidden', 'violations', 'tests', 'lines', 'time', 'cost'];
  const rows = s.arms.map((a) => [
    a.arm,
    String(a.n),
    pct(a.passRate),
    `[${pct(a.ci[0])}, ${pct(a.ci[1])}]`,
    a.delta === null ? '—' : `${a.delta >= 0 ? '+' : ''}${Math.round(a.delta * 100)}pp`,
    a.hidden.toFixed(2),
    a.violations.toFixed(1),
    a.tests.toFixed(1),
    String(Math.round(a.lines)),
    dur(a.ms) + (a.timeouts ? ` (${a.timeouts} timeout)` : ''),
    a.costUsd === null ? '—' : `$${a.costUsd.toFixed(2)}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  /** @param {string[]} r */
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const verdicts = s.arms
    .filter((a) => a.deltaCi)
    .map((a) => {
      const [lo, hi] = /** @type {[number, number]} */ (a.deltaCi);
      const range = `Δ 95% CI [${Math.round(lo * 100)}pp, ${Math.round(hi * 100)}pp]`;
      if (lo > 0) return `${a.arm} beats ${s.arms[0].arm}: ${range}`;
      if (hi < 0) return `${a.arm} is worse than ${s.arms[0].arm}: ${range}`;
      return `${a.arm} vs ${s.arms[0].arm}: not significant, ${range}; add trials or tasks`;
    });
  return [line(head), ...rows.map(line), '', ...s.tasks.map((t) => `${t.task}: ${Object.entries(t.arms).map(([a, v]) => `${a} ${v}`).join(', ')}`), '', ...verdicts];
}
