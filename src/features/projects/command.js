import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readJson, writeJson } from '../../core/files.js';
import { readEvents } from '../../core/state.js';
import { age } from '../../core/text.js';
import { readTasks } from '../board/store.js';
import { readQueue } from '../queue/store.js';
import { readReviews } from '../review/store.js';
import { computeTrust } from '../trust/compute.js';

/** @param {NodeJS.ProcessEnv} env */
const registry = (env) => join(env.WOLOLO_HOME ?? join(env.HOME ?? homedir(), '.wololo'), 'projects.json');

/** @param {NodeJS.ProcessEnv} env @returns {{ name: string, path: string }[]} */
const read = (env) => readJson(registry(env), []);

/** @param {string} path */
export function status(path) {
  const tasks = readTasks(path);
  const gate = readEvents(path, 'gate').at(-1);
  return {
    open: readQueue(path).filter((i) => i.status === 'open').length,
    claimed: tasks.filter((t) => t.status === 'claimed').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    reviews: readReviews(path).items.filter((r) => r.status === 'pending').length,
    gate: gate ? `${gate.ok ? 'green' : 'red'} ${age(Date.now() - Date.parse(gate.ts))} ago` : 'never run',
    trust: computeTrust(path).name,
  };
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'projects add',
    summary: 'Register a project so you can run several in parallel and move between them.',
    args: [{ name: 'path', description: 'Project path (default: this project)' }],
    options: { name: { type: 'string', description: 'Display name' } },
    async run(input, ctx) {
      const path = resolve(ctx.cwd, input.path ?? ctx.root);
      const list = read(ctx.env).filter((r) => r.path !== path);
      list.push({ name: input.name ?? basename(path), path });
      writeJson(registry(ctx.env), list);
      return { ok: true, summary: `registered ${path} (${list.length} project(s))` };
    },
  },
  {
    name: 'projects remove',
    summary: 'Unregister a project.',
    args: [{ name: 'name', description: 'Name or path', required: true }],
    async run(input, ctx) {
      const list = read(ctx.env);
      const next = list.filter((r) => r.name !== input.name && r.path !== resolve(ctx.cwd, input.name));
      writeJson(registry(ctx.env), next);
      return { ok: next.length < list.length, summary: `${list.length - next.length} removed` };
    },
  },
  {
    name: 'projects status',
    summary: 'One line per project: queue, board, reviews, last gate, trust. Decide where to spend attention.',
    async run(_input, ctx) {
      const rows = read(ctx.env).map((r) => ({ ...r, ...(existsSync(r.path) ? status(r.path) : { missing: true }) }));
      return {
        ok: true,
        summary: `${rows.length} project(s)`,
        details: rows.map((r) =>
          'missing' in r ? `${r.name}: missing (${r.path})` : `${r.name}: gate ${r.gate}, ${r.open} queued, ${r.todo} todo / ${r.claimed} in progress / ${r.blocked} blocked, ${r.reviews} to review, trust ${r.trust}`,
        ),
        data: rows,
      };
    },
  },
];
