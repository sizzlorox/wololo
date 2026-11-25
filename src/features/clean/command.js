import { clean } from './clean.js';

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'clean',
    summary: 'Housekeeping: rotate big logs (3 generations kept), cap transcripts at 100MB, remove stale temp files and locks, finished workers\' files, and merged worktrees and branches. Never touches unmerged or running work. Autopilot runs it when it starts.',
    options: {
      dryRun: { type: 'boolean', description: 'Show what would be done, change nothing' },
      maxRunsMb: { type: 'number', description: 'Transcripts kept, newest first, up to this many MB', default: 100 },
    },
    async run(input, ctx) {
      const r = clean(ctx.root, { dryRun: input.dryRun, maxRunsMB: input.maxRunsMb });
      const mb = (r.freed / 1024 / 1024).toFixed(1);
      return { ok: true, summary: r.actions.length ? `${input.dryRun ? 'would free' : 'freed'} ${mb}MB in ${r.actions.length} action(s)` : 'nothing to clean', details: r.actions, data: r };
    },
  },
];
