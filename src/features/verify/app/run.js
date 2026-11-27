import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from '../../../core/exec.js';
import { ensureDir } from '../../../core/files.js';
import { spawn } from '../../../core/proc.js';
import { statePath } from '../../../core/state.js';

/** What every way of opening an app shares: starting it, waiting, keeping what was seen. */

/** Where what the check saw is kept. @param {import('./index.js').Where} where @param {string} ext */
export function shotPath(where, ext) {
  const dir = statePath(where.root, 'shots');
  ensureDir(dir);
  return join(dir, `${where.name.replace(/[^\w.-]+/g, '-')}.${ext}`);
}

/**
 * Start the app; its output is collected, and stop() ends it and everything it started.
 * @param {string} command @param {string} cwd
 */
export function startApp(command, cwd) {
  const child = spawn(command, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none', CI: '1', FORCE_COLOR: '0' } });
  let output = '';
  /** @type {number | null} */
  let exit = null;
  child.stdout?.on('data', (b) => (output += b));
  child.stderr?.on('data', (b) => (output += b));
  const exited = new Promise((done) => child.on('close', (code) => done((exit = code ?? 1))));
  return {
    exited,
    output: () => output,
    exit: () => exit,
    stop: () => killTree(child.pid),
  };
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Lines that mean the app crashed, whatever it is written in. */
export const CRASH = /^(Traceback \(most recent call last\)|thread '.*' panicked at|panic: |Unhandled exception|Uncaught |Segmentation fault|Exception in thread|fatal error:|\S+Error: )/m;

/** What the app checks saw last (one file per app step, replaced each run). @param {string} root */
export function listShots(root) {
  const dir = statePath(root, 'shots');
  try {
    return readdirSync(dir).filter((f) => /\.(png|txt)$/.test(f)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}
