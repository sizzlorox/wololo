import { readEvents } from '../../core/state.js';
import { age, cluster, truncate } from '../../core/text.js';
import { readTasks } from '../board/store.js';
import { readQueue } from '../queue/store.js';
import { readReviews } from '../review/store.js';
import { interventions } from '../transcripts/parse.js';
import { sessionsFor } from '../transcripts/command.js';

/**
 * Rough human-minutes per signal. Crude on purpose: the ranking matters, not the absolute number.
 */
const COST = { blocked: 15, review: 5, untriaged: 2, redGate: 3, intervention: 2 };

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'bottleneck',
    summary: 'Where are YOU the bottleneck? Ranked from real data: board, reviews, queue, gates, rule hits, transcripts.',
    options: {
      transcripts: { type: 'boolean', description: 'Include transcript interventions', default: true },
      dir: { type: 'string[]', description: 'Transcript dirs' },
      days: { type: 'number', description: 'Transcript look-back days', default: 30 },
    },
    async run(input, ctx) {
      const { root, config } = ctx;
      /** @type {{ minutes: number, signal: string, action: string }[]} */
      const out = [];

      if (!config.verify.steps.length) out.push({ minutes: 999, signal: 'no verify steps: you are the meat proxy for every change', action: 'configure verify.steps and write the verify-app skill' });

      const blocked = readTasks(root).filter((t) => t.status === 'blocked' && t.blockedOn === 'human');
      if (blocked.length)
        out.push({ minutes: blocked.length * COST.blocked, signal: `${blocked.length} task(s) blocked on a human: ${blocked.slice(0, 3).map((t) => truncate(t.title, 40)).join('; ')}`, action: 'answer once, then encode the answer (skill, rule, or AGENTS.md) so agents stop asking' });

      const pending = readReviews(root).items.filter((r) => r.status === 'pending');
      if (pending.length) out.push({ minutes: pending.length * COST.review, signal: `${pending.length} sampled commit(s) waiting to be tasted`, action: 'review them, or let `wololo trust` lower the sample rate if the record is clean' });

      const open = readQueue(root).filter((i) => i.status === 'open');
      if (open.length) {
        const oldest = Math.max(...open.map((i) => Date.now() - Date.parse(i.ts)));
        out.push({ minutes: open.length * COST.untriaged, signal: `${open.length} untriaged queue item(s), oldest ${age(oldest)}`, action: 'run the triage skill: wololo queue patterns → group under coordinator tasks' });
      }

      const gates = readEvents(root, 'gate').slice(-50);
      const red = gates.filter((g) => !g.ok);
      if (red.length) {
        /** @type {Record<string, number>} */
        const parts = {};
        for (const g of red) for (const p of g.failed ?? []) parts[p] = (parts[p] ?? 0) + 1;
        const top = Object.entries(parts).sort((a, b) => b[1] - a[1])[0];
        out.push({ minutes: red.length * COST.redGate, signal: `${red.length}/${gates.length} recent gates red, mostly ${top?.[0]}`, action: top?.[0] === 'verify' ? 'make verify faster/clearer, or add a rule that catches the failure earlier' : `invest in ${top?.[0]}` });
      }

      /** @type {Record<string, number>} */
      const hits = {};
      for (const e of readEvents(root, 'hook')) for (const [r, n] of Object.entries(e.byRule ?? {})) hits[r] = (hits[r] ?? 0) + /** @type {number} */ (n);
      const topHits = Object.entries(hits).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (topHits.length)
        out.push({ minutes: 0, signal: `agents keep hitting rules: ${topHits.map(([r, n]) => `${r}×${n}`).join(', ')}`, action: 'rules work, but make the right way easier: a helper, a codemod, or a line in the relevant skill' });

      if (input.transcripts) {
        try {
          const sessions = sessionsFor({ ...input, allProjects: false }, ctx);
          const ivs = sessions.flatMap((s) => interventions(s));
          if (ivs.length) {
            const top = cluster(ivs, (m) => m.text.slice(0, 400), 0.2)[0];
            out.push({ minutes: ivs.length * COST.intervention, signal: `${ivs.length} intervention(s) in ${sessions.length} session(s); most common: "${truncate(top[0].text, 80)}" ×${top.length}`, action: 'run the mine-transcripts skill and encode the top cluster' });
          }
        } catch {
          // transcripts are optional evidence
        }
      }

      out.sort((a, b) => b.minutes - a.minutes);
      return {
        ok: true,
        summary: out.length ? `top bottleneck: ${out[0].signal}` : 'no bottleneck signals: go build something (or check that events are being recorded)',
        details: out.map((o) => `~${o.minutes}m  ${o.signal}\n    → ${o.action}`),
        data: out,
      };
    },
  },
];
