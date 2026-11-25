import { age } from '../../../core/text.js';
import { commands as boardCommands } from '../../board/command.js';
import { commands as queueCommands } from '../../queue/command.js';
import { readQueue } from '../../queue/store.js';
import { listDetail, moveIn } from '../layout.js';

const queue = Object.fromEntries(queueCommands.map((c) => [c.name, c]));
const board = Object.fromEntries(boardCommands.map((c) => [c.name, c]));
const FILTERS = ['open', 'grouped', 'done', 'dropped', 'all'];

/**
 * Buffered findings: read them in full, add, resolve or drop, turn into a task, cluster into patterns, pull sources.
 * @type {import('../app.js').Screen}
 */
export const queueScreen = {
  id: 'queue',
  title: 'Queue',
  load(ctx, ui) {
    ui.filter ??= 'open';
    const all = readQueue(ctx.root);
    const items = all.filter((i) => ui.filter === 'all' || i.status === ui.filter).reverse();
    ui.at = moveIn(ui.at ?? 0, 0, items.length);
    return { items, item: items[ui.at], open: all.filter((i) => i.status === 'open').length, sources: ctx.config.sources?.length ?? 0 };
  },
  keys(d, ui) {
    if (ui.patterns) return [{ key: 'esc', label: 'back' }];
    return [
      { key: 'f', label: 'filter' },
      { key: 'a', label: 'add' },
      ...(d.item && d.item.status === 'open' ? [{ key: 'x', label: 'done' }, { key: 'X', label: 'drop' }, { key: 't', label: 'make task' }] : []),
      { key: 'p', label: 'patterns' },
      ...(d.sources ? [{ key: 'P', label: 'pull sources' }] : []),
    ];
  },
  render(d, ui, w, h, c) {
    if (ui.patterns) return listDetail({ title: 'Patterns', rows: [ui.patterns.summary], at: 0, detailTitle: 'Clusters', detail: ui.patterns.details.length ? ui.patterns.details : ['no clusters'], scroll: ui.scroll }, w, h, c);
    const kindColor = /** @type {Record<string, string>} */ ({ mistake: '31', bug: '31', env: '33', finding: '36' });
    const rows = d.items.map((/** @type {import('../../queue/store.js').QueueItem} */ i) => `${c(kindColor[i.kind] ?? '2', i.kind.padEnd(8))} ${i.title}`);
    const i = /** @type {import('../../queue/store.js').QueueItem | undefined} */ (d.item);
    const detail = i
      ? [
          c('1', i.title),
          `${i.kind} · ${i.status} · from ${i.source} · ${age(Date.now() - Date.parse(i.ts))} ago`,
          c('2', i.id),
          ...(i.tags.length ? [`tags: ${i.tags.join(', ')}`] : []),
          ...(i.url ? [`link: ${i.url}`] : []),
          ...(i.task ? [`grouped into task ${i.task}`] : []),
          '',
          i.body || c('2', '(no details)'),
        ]
      : [c('2', 'nothing here')];
    return [` ${c('2', `filter: ${ui.filter} · ${d.open} open`)}`, ...listDetail({ title: 'Items', rows, at: ui.at, detailTitle: 'Details', detail, scroll: ui.scroll }, w, h - 1, c)];
  },
  async handle(key, d, ui, app) {
    const ctx = app.ctx;
    if (ui.patterns) {
      if (key === 'esc') ui.patterns = null;
      else if (key === 'pgdn') ui.scroll = (ui.scroll ?? 0) + 10;
      else if (key === 'pgup') ui.scroll = Math.max(0, (ui.scroll ?? 0) - 10);
      return;
    }
    if (key === 'up' || key === 'k') return void ((ui.at = moveIn(ui.at, -1, d.items.length)), (ui.scroll = 0));
    if (key === 'down' || key === 'j') return void ((ui.at = moveIn(ui.at, 1, d.items.length)), (ui.scroll = 0));
    if (key === 'pgdn') return void (ui.scroll = (ui.scroll ?? 0) + 10);
    if (key === 'pgup') return void (ui.scroll = Math.max(0, (ui.scroll ?? 0) - 10));
    if (key === 'f') return void ((ui.filter = FILTERS[(FILTERS.indexOf(ui.filter) + 1) % FILTERS.length]), (ui.at = 0));
    if (key === 'a')
      return app.ask('Queue a finding', [{ name: 'title', label: 'Title', required: true }, { name: 'kind', label: 'Kind', value: 'finding', hint: 'finding | bug | mistake | env | feedback' }, { name: 'body', label: 'Details' }, { name: 'tag', label: 'Tags', hint: 'comma separated' }], async (f) =>
        (await queue['queue add'].run({ title: f.title, kind: f.kind || 'finding', body: f.body, source: 'tui', tag: f.tag ? f.tag.split(',').map((s) => s.trim()).filter(Boolean) : undefined }, ctx)).summary,
      );
    if (key === 'p') {
      const r = await queue['queue patterns'].run({ min: 2, threshold: 0.25 }, ctx);
      ui.patterns = { summary: r.summary, details: (r.details ?? []).flatMap((x) => [...x.split('\n'), '']) };
      ui.scroll = 0;
      return r.summary;
    }
    if (key === 'P' && d.sources) {
      const r = await app.exec(['queue', 'pull']);
      return `${r.summary}${r.details?.length ? `: ${r.details.join('; ')}` : ''}`;
    }
    const i = d.item;
    if (!i || i.status !== 'open') return;
    if (key === 'x') return (await queue['queue resolve'].run({ ids: [i.id] }, ctx)).summary;
    if (key === 'X') return app.confirm(`Drop "${i.title}"?`, async () => (await queue['queue resolve'].run({ ids: [i.id], drop: true }, ctx)).summary);
    if (key === 't')
      return app.ask('Turn this finding into a task', [{ name: 'title', label: 'Title', value: i.title, required: true }, { name: 'group', label: 'Group', value: 'general' }, { name: 'body', label: 'Description', value: i.body }], async (f) =>
        (await board['task add'].run({ title: f.title, group: f.group || 'general', body: f.body, fromQueue: [i.id], force: true }, ctx)).summary,
      );
  },
};
