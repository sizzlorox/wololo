import { readEvents } from '../../core/state.js';
import { readReviews } from '../review/store.js';

/**
 * The trust ladder, computed from evidence rather than vibes: post-merge review verdicts,
 * gate pass rate and reverts. Each rung hands off more and samples less, but never zero.
 */
export const LADDER = [
  { level: 0, name: 'pair', minReviews: 0, minOk: 0, sampleRate: 1, verifiers: 1, parallel: 1, autoMerge: false, advice: 'Review everything. Invest in verify steps and rules before handing off more.' },
  { level: 1, name: 'supervised', minReviews: 5, minOk: 0.7, sampleRate: 0.5, verifiers: 1, parallel: 2, autoMerge: false, advice: 'Agents open PRs, you review half. Turn every fix-env verdict into a rule.' },
  { level: 2, name: 'sampled', minReviews: 10, minOk: 0.85, sampleRate: 0.25, verifiers: 2, parallel: 4, autoMerge: true, advice: 'Gate-green PRs may self-merge. Sample a quarter after merge.' },
  { level: 3, name: 'autopilot', minReviews: 20, minOk: 0.95, sampleRate: 0.1, verifiers: 3, parallel: 8, autoMerge: true, advice: 'Run several projects in parallel. Keep tasting 10%; revert and constrain on any miss.' },
];

/** @param {string} root */
export function computeTrust(root) {
  const reviewed = readReviews(root).items.filter((r) => r.status !== 'pending').slice(-30);
  const okRate = reviewed.length ? reviewed.filter((r) => r.status === 'ok').length / reviewed.length : 0;
  const reverts = reviewed.filter((r) => r.status === 'revert').length;
  const gates = readEvents(root, 'gate').slice(-50);
  const gatePass = gates.length ? gates.filter((g) => g.ok).length / gates.length : 0;
  let rung = LADDER[0];
  for (const r of LADDER) {
    const revertOk = r.level < 3 || reverts <= 1;
    const gateOk = r.level < 2 || gatePass >= 0.5;
    if (reviewed.length >= r.minReviews && okRate >= r.minOk && revertOk && gateOk) rung = r;
  }
  const next = LADDER[rung.level + 1];
  return {
    ...rung,
    metrics: { reviewed: reviewed.length, okRate: round(okRate), reverts, gates: gates.length, gatePass: round(gatePass) },
    next: next ? `${next.name}: needs ≥${next.minReviews} reviews at ≥${next.minOk * 100}% ok${next.level >= 2 ? ', gate pass ≥50%' : ''}${next.level >= 3 ? ', ≤1 revert' : ''}` : undefined,
  };
}

/** @param {number} x */
const round = (x) => Math.round(x * 100) / 100;
