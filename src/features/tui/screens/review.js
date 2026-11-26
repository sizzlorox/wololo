import { join } from 'node:path';
import { gitOut } from '../../../core/git.js';
import { age } from '../../../core/text.js';
import { commands as reviewCommands } from '../../review/command.js';
import { readReviews } from '../../review/store.js';
import { computeTrust } from '../../trust/compute.js';
import { listDetail, moveIn } from '../layout.js';

const review = Object.fromEntries(reviewCommands.map((c) => [c.name, c]));
const MARK = /** @type {Record<string, [string, string]>} */ ({ pending: ['33', '·'], ok: ['32', '✓'], 'fix-env': ['31', '✗'], revert: ['31', '↺'] });

/** Commit diffs, read once per commit: they do not change. @type {Map<string, string[]>} */
const shown = new Map();

/**
 * Sample instead of blocking: taste the commits autopilot sampled, record a verdict, and fix the
 * environment when something is wrong. Verdicts feed the trust ladder.
 * @type {import('../app.js').Screen}
 */
export const reviewScreen = {
  id: 'review',
  title: 'Review',
  load(ctx, ui) {
    ui.filter ??= 'pending';
    const all = readReviews(ctx.root).items;
    // newest first: what just landed is what you want to taste
    const items = all.filter((i) => ui.filter === 'all' || i.status === 'pending').sort((a, b) => String(b.date).localeCompare(String(a.date)));
    ui.at = moveIn(ui.at ?? 0, 0, items.length);
    const item = items[ui.at];
    if (item && !shown.has(item.sha)) shown.set(item.sha, gitOut(item.repo ? join(ctx.root, item.repo) : ctx.root, ['show', '--stat', '--patch', '--format=%H%n%an  %ci%n%n%B', item.sha]).split('\n'));
    return { items, item, diff: item ? shown.get(item.sha) : [], trust: computeTrust(ctx.root), pending: all.filter((i) => i.status === 'pending').length };
  },
  keys(d) {
    return [
      { key: 'f', label: 'filter' },
      { key: 's', label: 'sample now' },
      ...(d.item && d.item.status === 'pending' ? [{ key: 'o', label: 'ok' }, { key: 'e', label: 'fix the environment' }, { key: 'v', label: 'revert' }] : []),
      ...(d.item ? [{ key: 'pgup/dn', label: 'scroll' }] : []),
    ];
  },
  render(d, ui, w, h, c) {
    const t = d.trust;
    const head = ` ${c('1', `trust L${t.level}`)} ${c('2', `· sampling ${Math.round(t.sampleRate * 100)}% of commits · ${d.pending} waiting · ${ui.filter}`)}`;
    if (!d.items.length) return [head, ` ${c('2', ui.filter === 'pending' ? 'nothing to review · s samples new commits now' : 'no reviews yet')}`];
    const rows = d.items.map((/** @type {import('../../review/store.js').Review} */ i) => `${c(MARK[i.status][0], MARK[i.status][1])} ${i.repo ? c('36', `${i.repo}: `) : ''}${i.subject}  ${c('2', `${age(Date.now() - Date.parse(i.date))} ago`)}`);
    const paint = (/** @type {string} */ l) => (l.startsWith('+') && !l.startsWith('+++') ? c('32', l) : l.startsWith('-') && !l.startsWith('---') ? c('31', l) : l.startsWith('@@') ? c('36', l) : l);
    /** @type {import('../../review/store.js').Review} */
    const i = d.item;
    const detail = [...(i.note ? [c('31', `${i.status}: ${i.note}`), ''] : []), ...d.diff.map(paint)];
    return [head, ...listDetail({ title: 'Sampled commits', rows, at: ui.at, detailTitle: i.sha.slice(0, 10), detail, scroll: ui.scroll }, w, h - 1, c)];
  },
  async handle(key, d, ui, app) {
    if (key === 'up' || key === 'k') return void ((ui.at = moveIn(ui.at, -1, d.items.length)), (ui.scroll = 0));
    if (key === 'down' || key === 'j') return void ((ui.at = moveIn(ui.at, 1, d.items.length)), (ui.scroll = 0));
    if (key === 'pgdn') return void (ui.scroll = (ui.scroll ?? 0) + 15);
    if (key === 'pgup') return void (ui.scroll = Math.max(0, (ui.scroll ?? 0) - 15));
    if (key === 'f') return void ((ui.filter = ui.filter === 'pending' ? 'all' : 'pending'), (ui.at = 0));
    if (key === 's') return (await review['review sample'].run({}, app.ctx)).summary;
    /** @type {import('../../review/store.js').Review | undefined} */
    const i = d.item;
    if (!i || i.status !== 'pending') return;
    const record = async (/** @type {string} */ verdict, /** @type {string} */ note) => {
      const r = await review['review record'].run({ sha: i.sha, verdict, note: note || undefined }, app.ctx);
      return [r.summary, ...(r.details ?? [])].join(' · ');
    };
    if (key === 'o') return record('ok', '');
    if (key === 'e') return app.ask(`What was wrong in "${i.subject}"?`, [{ name: 'note', label: 'What, and which rule or constraint would have caught it', required: true }], (f) => record('fix-env', f.note));
    if (key === 'v') return app.ask(`Revert "${i.subject}"`, [{ name: 'note', label: 'Why', required: true }], (f) => record('revert', f.note));
  },
};
