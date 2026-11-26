import { commands as boardCommands } from '../../board/command.js';
import { blockReason, readTask, readTasks, writeTask } from '../../board/store.js';
import { readStatus } from '../../autopilot/status.js';
import { age } from '../../../core/text.js';
import { listDetail, moveIn } from '../layout.js';

const board = Object.fromEntries(boardCommands.map((c) => [c.name, c]));
const MARK = { done: '✓', claimed: '▶', blocked: '✗', todo: '·' };
const FILTERS = ['open', 'all', 'blocked', 'done'];

/** @param {import('../../board/store.js').Task} t @param {string} filter */
const shown = (t, filter) => filter === 'all' || (filter === 'open' ? t.status !== 'done' : t.status === filter);

/**
 * Every task on the board, by group, with full details; add, edit, reorder, retry, skip, block, note, delete, build.
 * @type {import('../app.js').Screen}
 */
export const boardScreen = {
  id: 'board',
  title: 'Board',
  load(ctx, ui) {
    const all = readTasks(ctx.root);
    const groups = [...new Set(all.map((t) => t.group))];
    ui.filter ??= 'open';
    // open on the plan autopilot is building
    ui.group ??= readStatus(ctx.root)?.group;
    ui.group = groups.includes(ui.group) ? ui.group : groups[0];
    const tasks = all
      .filter((t) => t.group === ui.group && shown(t, ui.filter))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.created.localeCompare(b.created));
    ui.at = moveIn(ui.at ?? 0, 0, tasks.length);
    const counts = Object.fromEntries(['todo', 'claimed', 'blocked', 'done'].map((s) => [s, all.filter((t) => t.group === ui.group && t.status === s).length]));
    return { all, groups, tasks, task: tasks[ui.at], counts, plan: all.some((t) => t.group === ui.group && t.seq !== undefined) };
  },
  keys(d) {
    const t = d.task;
    return [
      ...(d.groups.length > 1 ? [{ key: '←→', label: 'group' }] : []),
      { key: 'f', label: 'filter' },
      { key: 'a', label: 'add' },
      ...(t
        ? [
            { key: 'e', label: 'edit' },
            { key: 'o', label: 'note' },
            ...(t.status !== 'todo' ? [{ key: 'r', label: t.status === 'done' ? 'reopen' : 'release' }] : []),
            ...(t.status !== 'done' ? [{ key: 's', label: 'done' }, { key: 'b', label: 'block' }] : []),
            { key: 'J/K', label: 'move' },
            { key: 'd', label: 'delete' },
            { key: 'T', label: 'build this' },
          ]
        : []),
      ...(d.plan ? [{ key: 'B', label: 'build group' }] : []),
    ];
  },
  render(d, ui, w, h, c) {
    const rows = d.tasks.map((/** @type {import('../../board/store.js').Task} */ t) => `${MARK[t.status]} ${t.title}${t.blockedOn ? c('31', ` (on ${t.blockedOn})`) : ''}`);
    const t = /** @type {import('../../board/store.js').Task | undefined} */ (d.task);
    const detail = t
      ? [
          c('1', t.title),
          ...(t.status === 'blocked' && blockReason(t) ? [c('31', `blocked: ${blockReason(t)}`)] : []),
          `${t.status === 'blocked' ? c('31', `blocked on ${t.blockedOn ?? '?'}`) : t.status}${t.agent ? ` · ${t.agent}` : ''} · updated ${age(Date.now() - Date.parse(t.updated))} ago`,
          c('2', `${t.id}${t.seq !== undefined ? ` · step ${t.seq}` : ''}${t.splitInto?.length ? ` · split into ${t.splitInto.length}` : ''}${t.splitDepth ? ` · split depth ${t.splitDepth}` : ''}`),
          ...(t.deps?.length ? [`needs   ${t.deps.map((id) => { const dep = d.all.find((/** @type {any} */ x) => x.id === id); return dep ? `${dep.status === 'done' ? '✓' : '·'} ${dep.title}` : id; }).join(', ')}`] : []),
          ...(t.touches?.length ? [`changes ${t.touches.join(', ')}`] : []),
          '',
          t.body || c('2', '(no description)'),
          ...(t.goal ? ['', c('2', 'plan goal'), t.goal] : []),
          ...(t.queue.length ? ['', c('2', `absorbs queue items: ${t.queue.join(', ')}`)] : []),
          ...(t.notes.length ? ['', c('2', `notes (${t.notes.length})`), ...t.notes.map((n) => `• ${n}`)] : []),
        ]
      : [c('2', 'no task selected')];
    const counts = `${d.counts.todo} todo · ${d.counts.claimed} active · ${d.counts.blocked} blocked · ${d.counts.done} done`;
    const groupBar = ` ${d.groups.map((/** @type {string} */ g) => (g === ui.group ? c('7', ` ${g} `) : c('2', ` ${g} `))).join(' ')}`;
    return [groupBar, ` ${c('2', `filter: ${ui.filter} · ${counts}`)}`, ...listDetail({ title: `Tasks · ${ui.group ?? '—'}`, rows, at: ui.at, detailTitle: 'Details', detail, scroll: ui.scroll }, w, h - 2, c)];
  },
  async handle(key, d, ui, app) {
    const ctx = app.ctx;
    /** @type {import('../../board/store.js').Task | undefined} */
    const t = d.task;
    const resetScroll = () => (ui.scroll = 0);
    if (key === 'up' || key === 'k') return void ((ui.at = moveIn(ui.at, -1, d.tasks.length)), resetScroll());
    if (key === 'down' || key === 'j') return void ((ui.at = moveIn(ui.at, 1, d.tasks.length)), resetScroll());
    if (key === 'pgdn') return void (ui.scroll = (ui.scroll ?? 0) + 10);
    if (key === 'pgup') return void (ui.scroll = Math.max(0, (ui.scroll ?? 0) - 10));
    if (key === 'left' || key === 'right') {
      const i = d.groups.indexOf(ui.group);
      ui.group = d.groups[(i + (key === 'right' ? 1 : d.groups.length - 1)) % d.groups.length];
      ui.at = 0;
      return;
    }
    if (key === 'f') return void (ui.filter = FILTERS[(FILTERS.indexOf(ui.filter) + 1) % FILTERS.length]);
    if (key === 'a')
      return app.ask(`New task in ${ui.group ?? 'general'}`, [{ name: 'title', label: 'Title', required: true }, { name: 'body', label: 'Description', hint: 'intent, constraints, definition of done' }, { name: 'group', label: 'Group', value: ui.group ?? 'general' }], async (f) => {
        const r = await board['task add'].run({ title: f.title, body: f.body, group: f.group || 'general', force: true }, ctx);
        if (r.ok && d.plan && f.group === ui.group) {
          // in a plan, a new task goes after the selected one
          const here = t?.seq ?? Math.max(0, ...d.tasks.map((/** @type {any} */ x) => x.seq ?? 0));
          const next = d.tasks.find((/** @type {any} */ x) => (x.seq ?? 0) > here)?.seq;
          const task = /** @type {import('../../board/store.js').Task} */ (readTask(ctx.root, r.data.id));
          writeTask(ctx.root, { ...task, seq: next === undefined ? here + 1 : (here + next) / 2, goal: d.tasks.find((/** @type {any} */ x) => x.goal)?.goal });
        }
        return r.summary;
      });
    if (key === 'B' && d.plan) {
      app.launch(['autopilot', '--group', ui.group]);
      app.go('autopilot');
      return `building ${ui.group}`;
    }
    if (!t) return;
    if (key === 'e')
      return app.ask('Edit task', [{ name: 'title', label: 'Title', value: t.title, required: true }, { name: 'body', label: 'Description', value: t.body }], (f) => {
        const cur = readTask(ctx.root, t.id);
        if (!cur) return 'task is gone';
        writeTask(ctx.root, { ...cur, title: f.title, body: f.body });
        return `edited "${f.title}"`;
      });
    if (key === 'o') return app.ask(`Note on "${t.title}"`, [{ name: 'note', label: 'Note', required: true }], async (f) => (await board['task note'].run({ id: t.id, note: f.note }, ctx)).summary);
    if (key === 'r' && t.status !== 'todo') return (await board['task release'].run({ id: t.id }, ctx)).summary;
    if (key === 's' && t.status !== 'done') return app.ask(`Mark "${t.title}" done`, [{ name: 'note', label: 'Outcome', hint: 'what was done, or why it was skipped' }], async (f) => (await board['task done'].run({ id: t.id, note: f.note || 'done from the TUI' }, ctx)).summary);
    if (key === 'b' && t.status !== 'done')
      return app.ask(`Block "${t.title}"`, [{ name: 'on', label: 'Blocked on', value: 'human', required: true }, { name: 'reason', label: 'Reason' }], async (f) => (await board['task block'].run({ id: t.id, on: f.on, reason: f.reason }, ctx)).summary);
    if (key === 'd') return app.confirm(`Delete "${t.title}" from the board? This cannot be undone.`, async () => (await board['task remove'].run({ id: t.id }, ctx)).summary);
    if (key === 'T') {
      app.launch(['autopilot', '--task', t.id]);
      app.go('autopilot');
      return `building "${t.title}"`;
    }
    if (key === 'J' || key === 'K') {
      const j = ui.at + (key === 'J' ? 1 : -1);
      const other = d.tasks[j];
      if (!other) return;
      // give every task in view a seq first, so swapping is well defined
      d.tasks.forEach((/** @type {any} */ x, /** @type {number} */ i) => x.seq === undefined && writeTask(ctx.root, { ...x, seq: i + 1 }));
      const a = readTask(ctx.root, t.id);
      const b = readTask(ctx.root, other.id);
      if (!a || !b) return;
      writeTask(ctx.root, { ...a, seq: b.seq });
      writeTask(ctx.root, { ...b, seq: a.seq });
      ui.at = j;
      return `moved "${t.title}" ${key === 'J' ? 'down' : 'up'}`;
    }
  },
};
