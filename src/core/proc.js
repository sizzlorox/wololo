// The one module that imports node:child_process (rule: child-process-via-proc).
//
// Every child starts with windowsHide. The TUI runs autopilot detached, and on Windows a detached
// process has no console: any console program it starts (omp.exe, git, cargo) would otherwise open a
// new, visible terminal window. Hidden, the child gets a console without a window, and its own
// children share it.
import * as cp from 'node:child_process';

/** @param {any} args @param {any} opts */
const hidden = (args, opts) => (Array.isArray(args) ? [args, { windowsHide: true, ...opts }] : [{ windowsHide: true, ...args }]);

/** @type {typeof cp.spawn} */
export const spawn = /** @type {any} */ ((/** @type {string} */ command, /** @type {any} */ args, /** @type {any} */ opts) => cp.spawn(command, ...hidden(args, opts)));

/** @type {typeof cp.spawnSync} */
export const spawnSync = /** @type {any} */ ((/** @type {string} */ command, /** @type {any} */ args, /** @type {any} */ opts) => cp.spawnSync(command, ...hidden(args, opts)));
