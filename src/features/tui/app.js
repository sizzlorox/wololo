import { spawn } from '../../core/proc.js';
import { launch as launchDetached } from '../watch/actions.js';
import { box, fit, pad, painter, width } from '../watch/widgets.js';
import { decode, editForm, form as makeForm } from './input.js';

/**
 * The TUI shell: tabs, a status line, a key footer, and overlays (forms, confirmations, help).
 * Screens own their content; this file owns the terminal.
 *
 * @typedef {{ key: string, label: string }} Key
 *
 * @typedef {object} App   what a screen can ask of the shell
 * @property {import('../../core/types.js').Ctx} ctx
 * @property {(title: string, fields: import('./input.js').FieldSpec[], onSubmit: (values: Record<string, string>) => Promise<string | void> | string | void) => void} ask
 * @property {(text: string, onYes: () => Promise<string | void> | string | void) => void} confirm
 * @property {(args: string[]) => Promise<import('../../core/types.js').Result>} exec  run a wololo command in a child process
 * @property {(args: string[]) => void} launch   start a wololo command in the background
 * @property {(message: string) => void} say
 * @property {(id: string) => void} go
 *
 * @typedef {object} Screen
 * @property {string} id
 * @property {string} title
 * @property {(ctx: import('../../core/types.js').Ctx, ui: Record<string, any>) => any} load   read what to show; called every frame, keep it cheap
 * @property {(data: any, ui: Record<string, any>) => Key[]} keys
 * @property {(data: any, ui: Record<string, any>, w: number, h: number, c: import('../watch/widgets.js').Paint) => string[]} render
 * @property {(key: string, data: any, ui: Record<string, any>, app: App) => Promise<string | void> | string | void} handle
 *
 * @typedef {object} Io
 * @property {NodeJS.ReadableStream & { isTTY?: boolean, setRawMode?: (on: boolean) => void }} stdin
 * @property {{ write: (s: string) => any, columns?: number, rows?: number, on?: Function, off?: Function }} stdout
 */

// help first: when a screen has many keys the footer is cut at the right, and ? lists them all
const GLOBAL = [
  { key: '?', label: 'all keys' },
  { key: 'tab', label: 'next tab' },
  { key: 'q', label: 'quit' },
];

/**
 * Run a wololo command in a child, so its output never lands on the TUI's screen.
 * @param {string} root @param {string} entry @param {string[]} args
 * @returns {Promise<import('../../core/types.js').Result>}
 */
export function execWololo(root, entry, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry, ...args, '--json'], { cwd: root, windowsHide: true, env: { ...process.env, WOLOLO_DETACHED: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('error', (e) => done({ ok: false, summary: e.message }));
    child.on('close', (code) => {
      try {
        const r = JSON.parse(out);
        done({ ok: r.ok, summary: r.summary, details: [...(r.details ?? []), ...(err.trim() ? ['', 'stderr:', ...err.trim().split('\n')] : [])], data: r.data });
      } catch {
        const text = `${out}${err}`.trim();
        done({ ok: code === 0, summary: text.split('\n')[0] || `exited ${code}`, details: text.split('\n').slice(1) });
      }
    });
  });
}

/**
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ screens: Screen[], tab?: string, io?: Io, interval?: number, entry?: string }} opts
 */
export async function runApp(ctx, opts) {
  const io = opts.io ?? { stdin: process.stdin, stdout: process.stdout };
  const out = io.stdout;
  const entry = opts.entry ?? process.argv[1];
  const screens = opts.screens;
  let active = Math.max(0, screens.findIndex((s) => s.id === opts.tab));
  /** @type {Record<string, Record<string, any>>} */
  const uis = Object.fromEntries(screens.map((s) => [s.id, {}]));
  /** @type {{ form: import('./input.js').Form, onSubmit: (v: Record<string, string>) => any } | null} */
  let asking = null;
  /** @type {{ text: string, onYes: () => any } | null} */
  let confirming = null;
  let help = false;
  let message = '';
  let busy = '';
  const c = painter(true);

  /**
   * Wait for quick work so keys apply in order; past 150ms let it finish in the background,
   * so a long command (gate takes minutes) never freezes navigation.
   * @param {Promise<void>} p
   */
  const settle = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 150))]);

  /** @param {Promise<any> | any} p @param {string} what */
  const track = async (p, what) => {
    busy = what;
    draw();
    try {
      const m = await p;
      if (typeof m === 'string' && m) message = m;
    } catch (e) {
      message = `error: ${/** @type {Error} */ (e).message}`;
    } finally {
      busy = '';
      draw();
    }
  };

  /** @type {App} */
  const app = {
    ctx,
    ask: (title, fields, onSubmit) => {
      asking = { form: makeForm(title, fields), onSubmit };
    },
    confirm: (text, onYes) => {
      confirming = { text, onYes };
    },
    exec: (args) => {
      busy = `running wololo ${args.join(' ')}`;
      draw();
      return execWololo(ctx.root, entry, args);
    },
    launch: (args) => launchDetached(ctx.root, args, entry),
    say: (m) => {
      message = m;
    },
    go: (id) => {
      const i = screens.findIndex((s) => s.id === id);
      if (i >= 0) active = i;
    },
  };

  /** @param {string[]} body @param {string[]} panel @param {number} w */
  const overlay = (body, panel, w) => {
    const top = Math.max(0, Math.floor((body.length - panel.length) / 3));
    const left = Math.max(0, Math.floor((w - width(panel[0] ?? '')) / 2));
    return body.map((l, i) => (i >= top && i < top + panel.length ? fit(' '.repeat(left) + panel[i - top], w) : l));
  };

  /** the last frame written: unchanged frames are skipped */
  let last = '';
  const draw = () => {
    const w = out.columns || 100;
    const h = out.rows || 30;
    const screen = screens[active];
    const ui = uis[screen.id];
    let data;
    let lines;
    try {
      data = screen.load(ctx, ui);
      lines = screen.render(data, ui, w, h - 3, c);
    } catch (e) {
      data = null;
      lines = [c('31', ` ${screen.title} failed to load: ${/** @type {Error} */ (e).message}`)];
    }
    const tabs = screens.map((s, i) => (i === active ? c('7', ` ${(i + 1) % 10} ${s.title} `) : c('2', ` ${(i + 1) % 10} ${s.title} `))).join('');
    const head = `${c('1', ' wololo ')} ${tabs}`;
    let body = lines.slice(0, h - 3);
    while (body.length < h - 3) body.push('');
    const pw = Math.min(w - 4, 90);
    if (asking) {
      const f = asking.form;
      // two lines per field; keep the active one in view when the form is taller than the screen
      const fit2 = Math.max(1, Math.floor((h - 10) / 2));
      const from = Math.max(0, Math.min(f.at - Math.floor(fit2 / 2), f.fields.length - fit2));
      const rows = f.fields.slice(from, from + fit2).flatMap((x, j) => {
        const i = from + j;
        const label = `${i === f.at ? c('33', '›') : ' '} ${x.label}${x.required ? '*' : ''}`;
        const val = i === f.at ? `${x.value}${c('7', ' ')}` : x.value || c('2', x.hint ?? '');
        return [label, `   ${val}`];
      });
      const more = f.fields.length > fit2 ? [c('2', `field ${f.at + 1}/${f.fields.length}`)] : [];
      body = overlay(body, box(f.title, [...rows, ...more, '', f.error ? c('31', f.error) : c('2', 'tab/↑↓ move · enter next/submit · esc cancel')], pw, c), w);
    } else if (confirming) {
      body = overlay(body, box('Confirm', [confirming.text, '', `${c('7', ' y ')} yes   ${c('7', ' n ')} no`], pw, c), w);
    } else if (help) {
      const keys = [...(data ? screen.keys(data, ui) : []), ...GLOBAL.slice(1), { key: '1-9, 0', label: 'jump to tab' }];
      body = overlay(body, box(`Help · ${screen.title}`, [...keys.map((k) => `${pad(k.key, 10)} ${k.label}`), '', c('2', 'esc close')], Math.min(pw, 60), c), w);
    }
    const status = busy ? c('33', ` ⟳ ${busy}…`) : message ? ` ${message}` : '';
    const keys = asking || confirming ? [] : [GLOBAL[0], ...(data ? screen.keys(data, ui) : []), ...GLOBAL.slice(1)];
    const footer = keys.map((k) => `${c('7', ` ${k.key} `)} ${k.label}`).join(' ');
    const frame = [head, ...body.map((l) => fit(l, w)), fit(status, w), fit(footer, w)].join('\x1b[K\n');
    if (frame === last) return; // most ticks change nothing: writing it anyway is what flickers
    last = frame;
    // Overwrite in place (home, clear each line's leftover, clear below) instead of clearing the
    // screen first; the synchronized-update brackets make the terminal show the frame all at once.
    out.write(`\x1b[?2026h\x1b[H${frame}\x1b[K\x1b[J\x1b[?2026l`);
  };

  /** @param {string} key */
  const onKey = async (key) => {
    if (key === 'ctrl-c') return true;
    if (asking) {
      const r = editForm(asking.form, key);
      const a = asking;
      if (r.cancel) asking = null;
      else if (r.submit) {
        asking = null;
        await settle(track(a.onSubmit(r.submit), 'working'));
      } else asking = { ...a, form: r.form };
      return false;
    }
    if (confirming) {
      const conf = confirming;
      if (key === 'y') {
        confirming = null;
        await settle(track(conf.onYes(), 'working'));
      } else if (key === 'n' || key === 'esc') confirming = null;
      return false;
    }
    if (help) {
      help = false;
      return false;
    }
    if (key === 'q') return true;
    if (key === '?') help = true;
    else if (key === 'tab') active = (active + 1) % screens.length;
    else if (key === 'backtab') active = (active + screens.length - 1) % screens.length;
    else if (/^[0-9]$/.test(key) && (Number(key) || 10) <= screens.length) active = (Number(key) || 10) - 1;
    else {
      const screen = screens[active];
      const ui = uis[screen.id];
      let data;
      try {
        data = screen.load(ctx, ui);
      } catch {
        return false;
      }
      if (busy && !['up', 'down', 'pgup', 'pgdn', 'home', 'end', 'left', 'right'].includes(key)) {
        message = `still ${busy}; wait for it to finish`;
        return false;
      }
      message = '';
      await settle(track(screen.handle(key, data, ui, app), 'working'));
    }
    return false;
  };

  out.write('\x1b[?1049h\x1b[?25l');
  draw();
  const timer = setInterval(draw, Math.max(0.2, opts.interval ?? 1) * 1000);
  // a resize reflows everything: clear once, then redraw
  const resized = () => {
    last = '';
    out.write('\x1b[2J');
    draw();
  };
  out.on?.('resize', resized);
  await new Promise((done) => {
    const stdin = io.stdin;
    const quit = () => {
      clearInterval(timer);
      out.off?.('resize', resized);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeAllListeners('data');
      out.write('\x1b[?25h\x1b[?1049l');
      done(undefined);
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    // Keys apply one at a time, in order, even when a handler awaits a child process.
    let queue = Promise.resolve(false);
    stdin.on('data', (b) => {
      for (const key of decode(b.toString())) {
        queue = queue.then(async (stop) => {
          if (stop) return true;
          const end = await onKey(key);
          if (end) quit();
          else draw();
          return end;
        });
      }
    });
  });
}
