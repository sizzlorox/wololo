// Which plan steps can start now, and why the others wait. Pure: the parallel runner asks, it decides.
import { overlaps } from './areas.js';
import { order } from './plan.js';

/**
 * Which steps to start now: their deps landed and merged (a split step counts once all its parts did),
 * they overlap nothing running or waiting to merge, up to the worker limit, in plan order.
 * @param {import('../board/store.js').Task[]} tasks  one group
 * @param {{ running: string[], unmerged: string[], workers: number }} now
 */
export function pickReady(tasks, now) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  /** @param {string} id @returns {boolean} */
  const landed = (id) => {
    const t = byId.get(id);
    if (!t) return true; // removed from the board
    if (t.status !== 'done' || now.unmerged.includes(id)) return false;
    return (t.splitInto ?? []).every(landed);
  };
  const busy = tasks.filter((t) => now.running.includes(t.id) || now.unmerged.includes(t.id));
  /** @type {import('../board/store.js').Task[]} */
  const picked = [];
  for (const t of [...tasks].sort((a, b) => order(a) - order(b))) {
    if (busy.length + picked.length >= now.workers) break;
    if (now.running.includes(t.id)) continue;
    const open = t.status === 'todo' || (t.status === 'claimed' && t.agent?.startsWith('autopilot:'));
    if (!open || !(t.deps ?? []).every(landed)) continue;
    if ([...busy, ...picked].some((o) => overlaps(t.touches ?? [], o.touches ?? []))) continue;
    picked.push(t);
  }
  return picked;
}


/**
 * Why each open step that will not start now is waiting: an unmerged dep, a shared file, or no free worker.
 * @param {import('../board/store.js').Task[]} tasks
 * @param {{ running: string[], unmerged: string[], workers: number }} now
 * @returns {Record<string, string>} task id → reason
 */
export function waitReasons(tasks, now) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ready = new Set(pickReady(tasks, now).map((t) => t.id));
  const busy = tasks.filter((t) => now.running.includes(t.id) || now.unmerged.includes(t.id));
  /** @param {string} id @returns {boolean} */
  const landed = (id) => {
    const t = byId.get(id);
    return !t || (t.status === 'done' && !now.unmerged.includes(id) && (t.splitInto ?? []).every(landed));
  };
  /** @type {Record<string, string>} */
  const out = {};
  for (const t of tasks) {
    const open = t.status === 'todo' || (t.status === 'claimed' && t.agent?.startsWith('autopilot:'));
    if (!open || ready.has(t.id) || now.running.includes(t.id)) continue;
    const dep = (t.deps ?? []).find((d) => !landed(d));
    if (dep) {
      out[t.id] = `needs ${byId.get(dep)?.title ?? dep} merged`;
      continue;
    }
    const other = busy.find((o) => overlaps(t.touches ?? [], o.touches ?? []));
    if (other) {
      const shared = (t.touches ?? []).find((x) => overlaps([x], other.touches ?? [])) ?? 'files';
      out[t.id] = !t.touches?.length ? `does not say which files it changes, so it runs alone` : `shares ${shared} with ${other.title} (${now.running.includes(other.id) ? 'running' : 'merging'})`;
      continue;
    }
    out[t.id] = 'no free worker';
  }
  return out;
}


/**
 * Files git names when it refuses to start a merge because they would be overwritten.
 * @param {string} stderr
 */
export function overwritten(stderr) {
  const out = [];
  let inList = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/would be overwritten by merge:/.test(line)) inList = true;
    else if (inList && /^\s+\S/.test(line)) out.push(line.trim());
    else inList = false;
  }
  return out;
}
