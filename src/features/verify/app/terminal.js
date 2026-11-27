import { writeFileSync } from 'node:fs';
import { CRASH, shotPath, sleep, startApp } from './run.js';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][\w]/g;

/**
 * A CLI or terminal app: run it; what it prints is its screen. A program that ends must exit 0;
 * one that keeps running (a TUI, a server) is stopped after waitMs and judged on what it showed.
 * Fails on a crash, on nothing printed, or on missing expected text.
 * @param {import('./index.js').AppCheck} check @param {import('./index.js').Where} where
 * @returns {Promise<import('./index.js').AppResult>}
 */
export async function runTerminal(check, where) {
  const app = startApp(/** @type {string} */ (check.start), where.cwd);
  await Promise.race([app.exited, sleep(check.waitMs ?? 3000)]);
  app.stop();
  const screen = app.output().replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
  const file = shotPath(where, 'txt');
  writeFileSync(file, screen);
  const allowed = (/** @type {string} */ s) => (check.allow ?? []).some((a) => s.includes(a));
  /** @type {string[]} */
  const problems = [];
  const exit = app.exit();
  const crash = CRASH.exec(screen);
  if (exit !== null && exit !== 0 && !allowed(`exit ${exit}`)) problems.push(`\`${check.start}\` exited with ${exit}`);
  if (crash && !allowed(crash[0])) problems.push(`it crashed: ${screen.slice(crash.index).split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
  if (!screen.trim()) problems.push('it printed nothing: there is nothing on screen to see');
  else if (check.expect && !screen.includes(check.expect)) problems.push(`its output never shows "${check.expect}"`);
  return { ok: problems.length === 0, problems, screenshot: file };
}
