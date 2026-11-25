import { age, jaccard, shortHash, slugify, tokenize, truncate } from '../../core/text.js';
import { readQueue, writeQueue } from '../queue/store.js';
import { post } from './inbox.js';
import { lock, readTask, readTasks, removeTask, unlock, writeTask } from './store.js';

/** @param {import('./store.js').Task} t */
const line = (t) =>
  `${t.id} [${t.group}] ${t.status}${t.agent ? ` by ${t.agent}` : ''}${t.blockedOn ? ` on ${t.blockedOn}` : ''} — ${truncate(t.title, 80)} (${age(Date.now() - Date.parse(t.updated))})`;

/**
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} id
 * @param {(t: import('./store.js').Task) => string | void} mutate  Return an error string to abort.
 * @returns {import('../../core/types.js').Result}
 */
function update(ctx, id, mutate) {
  const t = readTask(ctx.root, id);
  if (!t) return { ok: false, summary: `no task ${id}` };
  const err = mutate(t);
  if (err) return { ok: false, summary: err };
  writeTask(ctx.root, t);
  return { ok: true, summary: line(t), data: t };
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'task add',
    summary: 'Create a task under a coordinator group. Refuses near-duplicates so agents never double up.',
    args: [{ name: 'title', description: 'What outcome is wanted', required: true }],
    options: {
      group: { type: 'string', description: 'Coordinator group (one coordinator per group)', default: 'general' },
      body: { type: 'string', description: 'Intent, constraints, definition of done' },
      fromQueue: { type: 'string[]', description: 'Queue item ids this task absorbs' },
      force: { type: 'boolean', description: 'Create even if a similar open task exists' },
    },
    async run(input, ctx) {
      const toks = tokenize(input.title);
      const dup = readTasks(ctx.root).find((t) => t.status !== 'done' && jaccard(tokenize(t.title), toks) >= 0.6);
      if (dup && !input.force) return { ok: false, summary: `similar task already exists: ${line(dup)}`, data: dup };
      const now = new Date().toISOString();
      /** @type {import('./store.js').Task} */
      const task = { id: `${slugify(input.title).slice(0, 24)}-${shortHash(input.title + now)}`.replace(/^-/, ''), title: input.title, group: input.group, body: input.body ?? '', status: 'todo', queue: input.fromQueue ?? [], notes: [], created: now, updated: now };
      writeTask(ctx.root, task);
      if (task.queue.length) {
        const items = readQueue(ctx.root);
        for (const i of items) if (task.queue.includes(i.id)) ((i.status = 'grouped'), (i.task = task.id));
        writeQueue(ctx.root, items);
      }
      return { ok: true, summary: `created ${task.id}`, data: task };
    },
  },
  {
    name: 'task list',
    summary: 'Show the board.',
    options: { group: { type: 'string', description: 'Filter by group' }, status: { type: 'string', description: 'todo | claimed | blocked | done | open', default: 'open' } },
    async run(input, ctx) {
      const tasks = readTasks(ctx.root).filter((t) => (!input.group || t.group === input.group) && (input.status === 'open' ? t.status !== 'done' : t.status === input.status));
      return { ok: true, summary: `${tasks.length} task(s)`, details: tasks.map(line), data: tasks };
    },
  },
  {
    name: 'task groups',
    summary: 'Coordinator view: progress per group, who is on what, what is blocked.',
    async run(_input, ctx) {
      /** @type {Map<string, import('./store.js').Task[]>} */
      const groups = new Map();
      for (const t of readTasks(ctx.root)) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
      const details = [...groups].map(([g, ts]) => {
        /** @param {string} s */
        const n = (s) => ts.filter((t) => t.status === s).length;
        const agents = [...new Set(ts.filter((t) => t.status === 'claimed').map((t) => t.agent))].join(', ');
        return `${g}: ${n('done')}/${ts.length} done, ${n('claimed')} in progress${agents ? ` (${agents})` : ''}, ${n('todo')} todo, ${n('blocked')} blocked`;
      });
      return { ok: true, summary: `${groups.size} group(s)`, details };
    },
  },
  {
    name: 'task claim',
    summary: 'Atomically claim a task for an agent. Fails if someone else holds it.',
    args: [{ name: 'id', description: 'Task id', required: true }],
    options: { agent: { type: 'string', description: 'Agent name', default: 'agent' } },
    async run(input, ctx) {
      if (!readTask(ctx.root, input.id)) return { ok: false, summary: `no task ${input.id}` };
      if (!lock(ctx.root, input.id)) return { ok: false, summary: `${input.id} is already claimed (${readTask(ctx.root, input.id)?.agent ?? 'unknown'})` };
      return update(ctx, input.id, (t) => {
        t.status = 'claimed';
        t.agent = input.agent;
      });
    },
  },
  {
    name: 'task note',
    summary: 'Append a progress note. Agents building the same plan in parallel see it after their next tool call.',
    args: [{ name: 'id', description: 'Task id', required: true }, { name: 'note', description: 'Note', required: true }],
    async run(input, ctx) {
      const r = update(ctx, input.id, (t) => void t.notes.push(`${new Date().toISOString()} ${input.note}`));
      // agents building the same plan in parallel hear it after their next tool call
      if (r.ok) post(ctx.root, r.data.group, { from: r.data.id, title: r.data.title, text: input.note });
      return r;
    },
  },
  {
    name: 'task block',
    summary: 'Mark a task blocked. --on human feeds the bottleneck report.',
    args: [{ name: 'id', description: 'Task id', required: true }],
    options: { on: { type: 'string', description: 'What it waits on (human, another task id, …)', default: 'human' }, reason: { type: 'string', description: 'Why' } },
    async run(input, ctx) {
      unlock(ctx.root, input.id);
      return update(ctx, input.id, (t) => {
        t.status = 'blocked';
        t.blockedOn = input.on;
        if (input.reason) t.notes.push(`${new Date().toISOString()} blocked: ${input.reason}`);
      });
    },
  },
  {
    name: 'task done',
    summary: 'Complete a task and close the queue items it absorbed.',
    args: [{ name: 'id', description: 'Task id', required: true }],
    options: { note: { type: 'string', description: 'Outcome / link to commit or PR' } },
    async run(input, ctx) {
      unlock(ctx.root, input.id);
      const r = update(ctx, input.id, (t) => {
        t.status = 'done';
        t.blockedOn = undefined;
        if (input.note) t.notes.push(`${new Date().toISOString()} done: ${input.note}`);
      });
      if (r.ok) {
        const ids = /** @type {import('./store.js').Task} */ (r.data).queue;
        const items = readQueue(ctx.root);
        for (const i of items) if (ids.includes(i.id)) i.status = 'done';
        writeQueue(ctx.root, items);
      }
      return r;
    },
  },
  {
    name: 'task release',
    summary: 'Give a claimed or blocked task back to the pool.',
    args: [{ name: 'id', description: 'Task id', required: true }],
    async run(input, ctx) {
      unlock(ctx.root, input.id);
      return update(ctx, input.id, (t) => {
        t.status = 'todo';
        t.agent = undefined;
        t.blockedOn = undefined;
      });
    },
  },
  {
    name: 'task remove',
    summary: 'Delete a task from the board (a mistaken or obsolete step). To keep a record, use task done instead.',
    args: [{ name: 'id', description: 'Task id', required: true }],
    async run(input, ctx) {
      const t = readTask(ctx.root, input.id);
      if (!t) return { ok: false, summary: `no task ${input.id}` };
      removeTask(ctx.root, input.id);
      return { ok: true, summary: `removed ${line(t)}`, data: t };
    },
  },
];
