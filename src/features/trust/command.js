import { computeTrust } from './compute.js';

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'trust',
    summary: 'Where you are on the trust ladder, from real review and gate data, and how much to hand off.',
    async run(_input, ctx) {
      const t = computeTrust(ctx.root);
      return {
        ok: true,
        summary: `trust L${t.level} (${t.name}): sample ${t.sampleRate * 100}% of merges, ${t.verifiers} verifier(s), up to ${t.parallel} parallel agent(s), auto-merge ${t.autoMerge ? 'on' : 'off'}`,
        details: [
          `evidence: ${t.metrics.reviewed} reviews (${t.metrics.okRate * 100}% ok, ${t.metrics.reverts} reverts), ${t.metrics.gates} gates (${t.metrics.gatePass * 100}% pass)`,
          t.advice,
          ...(t.next ? [`next rung → ${t.next}`] : []),
        ],
        data: t,
      };
    },
  },
];
