import { progress } from '../autopilot/agent.js';
import { readStatus } from '../autopilot/status.js';
import { readTasks } from '../board/store.js';
import { messages } from '../board/inbox.js';

/** Is the process still there? @param {number} pid */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * @param {string} root
 * @param {{ width: number, height: number, color: boolean }} screen
 * @param {{ group?: string, selected?: string }} [ui]  plan and task picked in the TUI
 * @returns {import('./render.js').View}
 */
export function view(root, screen, ui = {}) {
  const status = readStatus(root);
  const all = status ? readTasks(root) : [];
  // Plans are groups autopilot builds in order (their tasks carry seq); newest first.
  const groups = [...new Set([status?.group, ...all.filter((t) => t.seq !== undefined).reverse().map((t) => t.group)])].filter((g) => typeof g === 'string');
  // a status that lost its plan (an older wololo let a merger overwrite it) falls back to the newest plan
  const group = ui.group ?? status?.group ?? groups[0];
  const tasks = all.filter((t) => t.group === group).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.created.localeCompare(b.created));
  const running = Boolean(status && status.state === 'running' && alive(status.pid));
  const git = running && status?.agent?.base ? progress(root, status.agent.base) : undefined;
  // parallel run: each worker's own status, and what the agents told each other
  const workers = running ? (status?.parallel?.running ?? []).map((w) => ({ ...w, status: readStatus(root, w.id) })) : [];
  const inbox = group ? messages(root, group).slice(-30) : [];
  return { status, tasks, alive: running, git, now: Date.now(), groups, group: ui.group ?? (status?.group ? undefined : group), selected: ui.selected, workers, inbox, ...screen };
}
