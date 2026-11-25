import { shortHash } from '../../core/text.js';
import { readTasks, writeTask } from '../board/store.js';
import { overlaps } from './areas.js';
import { order } from './plan.js';

const NOTE = 'seam for';

/**
 * A file most open steps change: it serializes the plan. Steps that list a dir count for every file in it.
 * @param {import('../board/store.js').Task[]} tasks
 * @returns {{ file: string, steps: number } | undefined}
 */
export function hotspot(tasks) {
  const open = tasks.filter((t) => t.status !== 'done' && t.touches?.length);
  if (open.length < 3) return undefined;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const t of open) for (const f of new Set(t.touches)) if (!f.endsWith('/') && !f.includes('*')) counts.set(f, (counts.get(f) ?? 0) + 1);
  const [file, steps] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  return file && steps / open.length > 0.5 ? { file, steps } : undefined;
}

/**
 * One file most open steps change makes a parallel plan run one step at a time. Put a step first
 * that turns it into a seam: a registry each piece registers into, so later steps change only their
 * own files. Deterministic: code decides there is a hotspot; the builder decides how the registry looks.
 * @param {string} root @param {string} group
 * @returns {import('../board/store.js').Task | undefined} the added step
 */
export function addSeam(root, group) {
  const tasks = readTasks(root).filter((t) => t.group === group);
  const hot = hotspot(tasks);
  if (!hot) return undefined;
  const id = `${group}-seam-${shortHash(hot.file)}`;
  if (tasks.some((t) => t.id === id)) return undefined;
  const open = tasks.filter((t) => t.status !== 'done').sort((a, b) => order(a) - order(b));
  const users = open.filter((t) => overlaps(t.touches ?? [], [hot.file]));
  const now = new Date().toISOString();
  const first = order(open[0] ?? { seq: 1 });
  /** @type {import('../board/store.js').Task} */
  const seam = {
    id,
    title: `Make ${hot.file} a registry the next steps plug into`,
    group,
    body: [
      `${hot.steps} upcoming steps each edit ${hot.file}, so they can only be built one at a time:`,
      ...users.map((t) => `- ${t.title}`),
      '',
      `Change ${hot.file} so that each of those pieces can be added without editing it: a registry (e.g. a list of systems, handlers or routes that modules add themselves to), with the existing behaviour moved onto it and covered by tests.`,
      'Do not build the upcoming steps; only make room for them. Done when the gate passes and adding a new piece needs no edit to this file.',
    ].join('\n'),
    status: 'todo',
    queue: [],
    notes: [`${now} ${NOTE} ${hot.file}: added by wololo so ${hot.steps} steps can build in parallel`],
    seq: first - 0.5,
    deps: [],
    touches: [hot.file],
    goal: tasks.find((t) => t.goal)?.goal,
    created: now,
    updated: now,
  };
  writeTask(root, seam);
  for (const t of users) writeTask(root, { ...t, deps: [...new Set([...(t.deps ?? []), id])] });
  return seam;
}

/**
 * After a seam step landed, the steps waiting on it still list the old hotspot file. Clear their
 * file lists so the annotator lists them again against the new registry. Once per seam.
 * @param {string} root @param {string} group
 * @returns {number} steps cleared
 */
export function afterSeam(root, group) {
  const tasks = readTasks(root).filter((t) => t.group === group);
  let n = 0;
  for (const seam of tasks.filter((t) => t.status === 'done' && t.notes.some((x) => x.includes(` ${NOTE} `)) && !t.notes.some((x) => x.includes('re-annotated')))) {
    for (const t of tasks) {
      if (t.status === 'done' || !t.deps?.includes(seam.id) || !t.touches?.length) continue;
      writeTask(root, { ...t, touches: [] });
      n++;
    }
    writeTask(root, { ...seam, notes: [...seam.notes, `${new Date().toISOString()} re-annotated the steps that waited on it`] });
  }
  return n;
}
