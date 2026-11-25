import { git } from '../../core/git.js';
import { enqueue } from '../queue/store.js';
import { computeTrust } from '../trust/compute.js';
import { readReviews, sampled, writeReviews } from './store.js';

/**
 * @param {string} root
 * @param {string | undefined} since
 */
function commits(root, since) {
  const range = since ? [`${since}..HEAD`] : ['-n', '50', 'HEAD'];
  const r = git(root, ['log', '--no-merges', '--format=%H%x1f%an%x1f%s%x1f%cI', ...range]);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, author, subject, date] = l.split('\x1f');
      return { sha, author, subject, date };
    });
}

/**
 * Put new commits up for tasting at the trust ladder's rate (never zero). Autopilot calls this after
 * every step lands, so review keeps up with the work without blocking it.
 * @param {string} root
 * @param {{ rate?: number, since?: string }} [opts]
 */
export function sampleCommits(root, opts = {}) {
  const state = readReviews(root);
  const rate = Math.max(0.05, opts.rate ?? computeTrust(root).sampleRate);
  const list = commits(root, opts.since ?? state.cursor);
  const known = new Set(state.items.map((i) => i.sha));
  const fresh = list.filter((c) => !known.has(c.sha));
  let picked = fresh.filter((c) => sampled(c.sha, rate));
  if (!picked.length && fresh.length) picked = [fresh.reduce((a, b) => (parseInt(a.sha.slice(0, 8), 16) <= parseInt(b.sha.slice(0, 8), 16) ? a : b))];
  const now = new Date().toISOString();
  state.items.push(...picked.map((c) => ({ ...c, status: /** @type {const} */ ('pending'), sampledAt: now })));
  if (list.length) state.cursor = list[0].sha;
  writeReviews(root, state);
  return { picked, fresh: fresh.length, rate };
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'review sample',
    summary: 'Sample merged commits for post-merge review. Rate defaults to the trust ladder; never zero.',
    options: {
      since: { type: 'string', description: 'Git ref to sample after (default: last sampled point, or last 50 commits)' },
      rate: { type: 'number', description: 'Sampling rate 0..1 (default from `wololo trust`)' },
    },
    async run(input, ctx) {
      const r = sampleCommits(ctx.root, { rate: input.rate, since: input.since });
      return {
        ok: true,
        summary: `sampled ${r.picked.length} of ${r.fresh} new commit(s) at ${Math.round(r.rate * 100)}%`,
        details: r.picked.map((c) => `${c.sha.slice(0, 10)} ${c.author}: ${c.subject}  →  git show ${c.sha.slice(0, 10)}`),
        data: r.picked,
      };
    },
  },
  {
    name: 'review list',
    summary: 'Commits waiting to be tasted.',
    options: { all: { type: 'boolean', description: 'Include reviewed' } },
    async run(input, ctx) {
      const items = readReviews(ctx.root).items.filter((i) => input.all || i.status === 'pending');
      return { ok: true, summary: `${items.length} review(s)`, details: items.map((i) => `${i.sha.slice(0, 10)} ${i.status} ${i.subject}${i.note ? ` — ${i.note}` : ''}`), data: items };
    },
  },
  {
    name: 'review record',
    summary: 'Record a verdict: ok | fix-env (environment must change) | revert. Non-ok verdicts are queued as mistakes.',
    args: [{ name: 'sha', description: 'Commit sha (prefix ok)', required: true }],
    options: {
      verdict: { type: 'string', description: 'ok | fix-env | revert', default: 'ok' },
      note: { type: 'string', description: 'What was wrong and which rule/constraint would have caught it' },
    },
    async run(input, ctx) {
      if (!['ok', 'fix-env', 'revert'].includes(input.verdict)) return { ok: false, summary: 'verdict must be ok, fix-env or revert' };
      const state = readReviews(ctx.root);
      let item = state.items.find((i) => i.sha.startsWith(input.sha));
      if (!item) {
        const c = commits(ctx.root, undefined).find((x) => x.sha.startsWith(input.sha));
        if (!c) return { ok: false, summary: `unknown commit ${input.sha}` };
        item = { ...c, status: 'pending', sampledAt: new Date().toISOString() };
        state.items.push(item);
      }
      item.status = input.verdict;
      item.note = input.note;
      item.reviewedAt = new Date().toISOString();
      writeReviews(ctx.root, state);
      if (input.verdict !== 'ok') {
        enqueue(ctx.root, [{ kind: 'mistake', source: 'review', id: item.sha.slice(0, 10), title: input.note ?? `${input.verdict}: ${item.subject}`, body: `commit ${item.sha}\n${item.subject}`, tags: [input.verdict] }]);
      }
      return {
        ok: true,
        summary: `${item.sha.slice(0, 10)} → ${input.verdict}`,
        details: input.verdict === 'revert' ? [`git revert ${item.sha.slice(0, 10)}, then add a rule so it cannot recur`] : input.verdict === 'fix-env' ? ['queued as a mistake; run `wololo queue patterns --kind mistake` to see if it repeats'] : [],
      };
    },
  },
];
