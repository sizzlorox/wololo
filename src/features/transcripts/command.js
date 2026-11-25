import { basename } from 'node:path';
import { cluster, tokenize, truncate } from '../../core/text.js';
import { enqueue } from '../queue/store.js';
import { interventions, loadSessions } from './parse.js';

/** @type {Record<string, import('../../core/types.js').OptionSpec>} */
const SCOPE = {
  dir: { type: 'string[]', description: 'Transcript dirs (default: Claude, Codex, Copilot, Gemini locations; or $WOLOLO_TRANSCRIPTS)' },
  allProjects: { type: 'boolean', description: 'Include sessions from other projects' },
  days: { type: 'number', description: 'Look back this many days', default: 90 },
};

/**
 * @param {import('../../core/types.js').Input} input
 * @param {import('../../core/types.js').Ctx} ctx
 */
export const sessionsFor = (input, ctx) => loadSessions({ dirs: input.dir, env: ctx.env, project: input.allProjects ? undefined : ctx.root, sinceDays: input.days });

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'recall',
    summary: 'Search past agent transcripts (all harnesses) for earlier decisions, context and fixes.',
    args: [{ name: 'query', description: 'What to look for', required: true }],
    options: { ...SCOPE, limit: { type: 'number', description: 'Max results', default: 8 }, role: { type: 'string', description: 'user | assistant | all', default: 'all' } },
    async run(input, ctx) {
      const sessions = sessionsFor(input, ctx);
      const q = [...tokenize(input.query)];
      if (!q.length) return { ok: false, summary: 'query has no searchable words' };
      const docs = sessions.flatMap((s) => s.messages.filter((m) => input.role === 'all' || m.role === input.role).map((m) => ({ s, m, toks: tokenize(m.text) })));
      const idf = Object.fromEntries(q.map((t) => [t, Math.log(1 + docs.length / (1 + docs.filter((d) => d.toks.has(t)).length))]));
      const hits = docs
        .map((d) => ({ ...d, score: q.reduce((a, t) => a + (d.toks.has(t) ? idf[t] : 0), 0) }))
        .filter((d) => d.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit);
      return {
        ok: true,
        summary: `${hits.length} hit(s) across ${sessions.length} session(s)`,
        details: hits.map((h) => `[${h.s.harness} ${new Date(h.s.mtime).toISOString().slice(0, 10)} ${basename(h.s.file)}] ${h.m.role}: ${snippet(h.m.text, q)}`),
        data: hits.map((h) => ({ harness: h.s.harness, file: h.s.file, role: h.m.role, ts: h.m.ts, score: h.score, text: h.m.text.slice(0, 2000) })),
      };
    },
  },
  {
    name: 'transcripts mine',
    summary: 'Find where you had to step in (corrections, interrupts) and workflows you repeat. Candidates for rules and skills.',
    options: { ...SCOPE, enqueue: { type: 'boolean', description: 'Queue repeated interventions as mistakes' }, top: { type: 'number', description: 'Clusters to show', default: 10 } },
    async run(input, ctx) {
      const sessions = sessionsFor(input, ctx);
      const ivs = sessions.flatMap((s) => interventions(s).map((m) => ({ s, m })));
      const ivClusters = cluster(ivs, (x) => x.m.text.slice(0, 500), 0.2).slice(0, input.top);
      const openers = sessions.map((s) => ({ s, m: s.messages.find((m) => m.role === 'user') })).filter((x) => x.m);
      const repeated = cluster(openers, (x) => /** @type {any} */ (x.m).text.slice(0, 500), 0.3).filter((g) => g.length >= 2).slice(0, input.top);
      if (input.enqueue) {
        enqueue(ctx.root, ivClusters.filter((g) => g.length >= 2).map((g) => ({ kind: 'mistake', source: 'transcripts', title: `${g.length}× ${truncate(g[0].m.text, 100)}`, body: g.slice(0, 5).map((x) => `- ${truncate(x.m.text, 300)}`).join('\n') })));
      }
      return {
        ok: true,
        summary: `${sessions.length} session(s), ${ivs.length} intervention(s) (${sessions.length ? (ivs.length / sessions.length).toFixed(1) : 0}/session), ${repeated.length} repeated workflow(s)`,
        details: [
          ...ivClusters.map((g) => `intervention ×${g.length}: ${g.slice(0, 3).map((x) => `"${truncate(x.m.text, 100)}"`).join(' | ')}\n    → repeated? make it a rule (mechanical) or a skill step (judgment)`),
          ...repeated.map((g) => `workflow ×${g.length}: ${g.slice(0, 3).map((x) => `"${truncate(/** @type {any} */ (x.m).text, 100)}"`).join(' | ')}\n    → you keep asking for this: make it a skill (wololo skills new)`),
        ],
        data: {
          sessions: sessions.length,
          interventions: ivs.length,
          clusters: ivClusters.map((g) => ({ count: g.length, examples: g.slice(0, 5).map((x) => x.m.text.slice(0, 500)) })),
          workflows: repeated.map((g) => ({ count: g.length, examples: g.slice(0, 5).map((x) => /** @type {any} */ (x.m).text.slice(0, 500)) })),
        },
      };
    },
  },
];

/**
 * @param {string} text
 * @param {string[]} q
 */
function snippet(text, q) {
  const lower = text.toLowerCase();
  const at = Math.max(0, Math.min(...q.map((t) => lower.indexOf(t)).filter((i) => i >= 0)) - 80);
  return truncate(text.slice(at, at + 240), 240);
}
