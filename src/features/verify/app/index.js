import { runTerminal } from './terminal.js';
import { runWeb } from './web.js';
import { runWindow } from './window.js';

/**
 * Open what was built the way a person would, and look at it. Tests prove the parts; this proves
 * the thing shows up: the page loads and draws, the game opens a window that is not blank, the CLI
 * prints something and does not crash. Every check keeps what it saw (a screenshot, or the terminal
 * text) for the judge agent and for a human to look at: no machine check can tell good art from bad.
 *
 * Which way to open it follows from the fields:
 *   url     a web app or anything a browser shows: opened headless (Chrome or Edge)
 *   window  a desktop app or native game: started, then its window is captured (title substring, or "*" for any new window)
 *   neither a CLI or terminal app: run, its output is the screen
 *
 * @typedef {object} AppCheck
 * @property {string} [start]    command that runs the app (or serves it, for a url); stopped after
 * @property {string} [url]      page to open: http(s) URL, or a file relative to the repo (index.html)
 * @property {string} [window]   title of the window the app opens ("*": any window it opens)
 * @property {string} [expect]   url: CSS selector that must be on screen and not blank (default body); terminal: text the output must contain
 * @property {number} [waitMs]   how long to let it run before looking (default 3000; window 5000)
 * @property {number} [readyMs]  how long a server may take to answer (default 90000)
 * @property {string[]} [allow]  substrings of errors to ignore (a known third-party warning)
 *
 * @typedef {{ ok: boolean, problems: string[], screenshot?: string }} AppResult
 * @typedef {{ cwd: string, root: string, name: string }} Where
 */

/** @param {AppCheck} check */
export const kindOf = (check) => (check.url ? 'web' : check.window ? 'window' : 'terminal');

/**
 * @param {AppCheck} check @param {Where} where
 * @returns {Promise<AppResult>}
 */
export function runAppCheck(check, where) {
  const kind = kindOf(check);
  if (kind !== 'web' && !check.start) return Promise.resolve({ ok: false, problems: ['this app check has nothing to run: set start (the command that runs the app)'] });
  return kind === 'web' ? runWeb(check, where) : kind === 'window' ? runWindow(check, where) : runTerminal(check, where);
}
