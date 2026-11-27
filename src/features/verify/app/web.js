import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { killTree, onPath } from '../../../core/exec.js';
import { spawn } from '../../../core/proc.js';
import { tail } from '../../../core/text.js';
import { blankness } from './png.js';
import { shotPath, sleep, startApp } from './run.js';

/**
 * Opening a url: a headless Chrome or Edge (already installed, driven over the DevTools protocol;
 * no dependencies). Fails on uncaught errors, console.error, assets that fail to load (404s), and the
 * expected element missing or blank.
 */

const CANDIDATES = {
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
};

/** Chrome, Chromium or Edge: WOLOLO_BROWSER, else the usual install places. */
export function findBrowser() {
  if (process.env.WOLOLO_BROWSER) return process.env.WOLOLO_BROWSER;
  const local = process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : [];
  const list = [...local, ...(CANDIDATES[/** @type {keyof typeof CANDIDATES} */ (process.platform)] ?? CANDIDATES.linux)];
  return list.find((p) => (isAbsolute(p) ? existsSync(p) : onPath(p)));
}

/** Wait until a URL answers at all (a dev server is up). @param {string} url @param {number} ms */
async function reachable(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await sleep(300);
    }
  }
  return false;
}

/**
 * A minimal DevTools-protocol client over the WebSocket Node ships.
 * @param {string} wsUrl
 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`cannot connect to the browser at ${wsUrl}`));
  });
  let id = 0;
  /** @type {Map<number, { ok: (v: any) => void, fail: (e: Error) => void }>} */
  const pending = new Map();
  /** @type {((method: string, params: any) => void)[]} */
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) {
      const p = /** @type {{ ok: (v: any) => void, fail: (e: Error) => void }} */ (pending.get(msg.id));
      pending.delete(msg.id);
      if (msg.error) p.fail(new Error(msg.error.message));
      else p.ok(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg.method, msg.params);
  };
  return {
    /** @param {string} method @param {Record<string, any>} [params] @returns {Promise<any>} */
    send: (method, params = {}) =>
      new Promise((ok, fail) => {
        pending.set(++id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    /** @param {(method: string, params: any) => void} f */
    on: (f) => listeners.push(f),
    close: () => ws.close(),
  };
}

/**
 * Start the browser headless with a fresh profile and return its DevTools page socket.
 * @param {string} bin
 */
async function launch(bin) {
  const profile = mkdtempSync(join(tmpdir(), 'wololo-browser-'));
  // swiftshader: WebGL renders without a GPU, so a canvas game draws in CI and over SSH too
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800', 'about:blank'];
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((ok, fail) => {
    let err = '';
    const timer = setTimeout(() => fail(new Error(`the browser did not start: ${err.slice(-300)}`)), 20000);
    child.stderr?.on('data', (b) => {
      err += b;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
      if (m) {
        clearTimeout(timer);
        ok(m[1]);
      }
    });
    child.on('error', (e) => fail(e));
  });
  const targets = /** @type {any[]} */ (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const page = targets.find((/** @type {any} */ t) => t.type === 'page');
  return {
    ws: /** @type {string} */ (page.webSocketDebuggerUrl),
    stop: () => {
      killTree(child.pid);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // the browser may still hold the profile for a moment; the OS cleans tmp
      }
    },
  };
}

/**
 * Open the page and judge it.
 * @param {import('./index.js').AppCheck} check @param {import('./index.js').Where} where
 * @returns {Promise<import('./index.js').AppResult>}
 */
export async function runWeb(check, where) {
  const bin = findBrowser();
  if (!bin) return { ok: false, problems: ['no Chrome, Chromium or Edge found to open the app; install one or set WOLOLO_BROWSER to its path'] };
  const target = check.url ?? '';
  const url = /^https?:|^file:/.test(target) ? target : pathToFileURL(resolve(where.cwd, target)).href;
  const allow = check.allow ?? [];
  const allowed = (/** @type {string} */ s) => allow.some((a) => s.includes(a));
  /** @type {string[]} */
  const problems = [];
  let server;
  let browser;
  try {
    if (check.start) {
      server = startApp(check.start, where.cwd);
      const up = await Promise.race([reachable(url, check.readyMs ?? 90_000), server.exited.then(() => false)]);
      if (!up) return { ok: false, problems: [server.exit() !== null ? `\`${check.start}\` exited (${server.exit()}) before ${url} answered:\n${tail(server.output(), 20)}` : `the app never answered at ${url} after \`${check.start}\``] };
    }
    browser = await launch(bin);
    const cdp = await connect(browser.ws);
    /** @type {Map<string, string>} */
    const urls = new Map();
    cdp.on((method, p) => {
      if (method === 'Network.requestWillBeSent') urls.set(p.requestId, p.request.url);
      let problem = '';
      if (method === 'Runtime.exceptionThrown') problem = `uncaught: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`;
      else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') problem = `console.error: ${p.args.map((/** @type {any} */ a) => a.value ?? a.description ?? '').join(' ')}`;
      // the browser asks for /favicon.ico on its own; a missing one is not the app's doing
      else if (method === 'Network.responseReceived' && p.response.status >= 400 && !p.response.url.endsWith('/favicon.ico')) problem = `${p.response.status} ${p.response.url}`;
      else if (method === 'Network.loadingFailed' && !p.canceled) problem = `failed to load (${p.errorText}): ${urls.get(p.requestId) ?? p.requestId}`;
      if (problem && !allowed(problem)) problems.push(problem.slice(0, 300));
    });
    await Promise.all(['Runtime.enable', 'Network.enable', 'Page.enable'].map((m) => cdp.send(m)));
    const loaded = new Promise((ok) => cdp.on((method) => method === 'Page.loadEventFired' && ok(true)));
    const nav = await cdp.send('Page.navigate', { url });
    if (nav.errorText) return { ok: false, problems: [`cannot open ${url}: ${nav.errorText}`] };
    if (!(await Promise.race([loaded, sleep(30_000).then(() => false)]))) problems.push(`the page did not finish loading within 30s: ${url}`);
    await sleep(check.waitMs ?? 3000);

    const selector = check.expect ?? 'body';
    const box = (await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()` })).result.value;
    const png = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    const file = shotPath(where, 'png');
    writeFileSync(file, png);
    if (!box) problems.push(`nothing matches "${selector}": the app did not render what this check expects`);
    else if (box.width < 2 || box.height < 2) problems.push(`"${selector}" has no size (${Math.round(box.width)}x${Math.round(box.height)}): it is not on screen`);
    else {
      const b = blankness(png, box);
      if (b?.blank) problems.push(`"${selector}" is blank (one colour covers ${Math.round(b.share * 100)}% of it): nothing was drawn`);
    }
    cdp.close();
    return { ok: problems.length === 0, problems, screenshot: file };
  } catch (e) {
    return { ok: false, problems: [...problems, `could not open the app: ${/** @type {Error} */ (e).message}`] };
  } finally {
    browser?.stop();
    server?.stop();
  }
}
