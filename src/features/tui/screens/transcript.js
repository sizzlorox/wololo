import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { statePath } from '../../../core/state.js';
import { age } from '../../../core/text.js';
import { readStatus } from '../../autopilot/status.js';
import { importLastRun, listRuns, readRunFrom, secrets } from '../../autopilot/transcript.js';
import { listDetail, moveIn, num, pane, wrap, wrapped } from '../layout.js';

/** What goes to the model: the prompt, other messages the harness sends, and tool results. */
const OUTBOUND = new Set(['prompt', 'sent', 'result']);
const RESULT_LINES = 12;

/** Parsed runs; a live run's new lines are parsed and scanned as they land. @type {Map<string, { end: number, entries: import('../../autopilot/transcript.js').Entry[], found: { kind: string, preview: string }[] }>} */
const cache = new Map();

/** @param {string} root @param {string} id */
function load(root, id) {
  const file = join(statePath(root, 'runs'), `${id}.jsonl`);
  const size = existsSync(file) ? statSync(file).size : 0;
  let run = cache.get(id);
  if (run && run.end === size) return run;
  if (!run || size < run.end) run = { end: 0, entries: [], found: [] }; // new, or rewritten shorter: from the top
  const more = readRunFrom(root, id, run.end);
  if (more.end === run.end) return run; // only a line still being written
  // a new object, so a render memoized on it sees the change
  run = { end: more.end, entries: [...run.entries, ...more.entries], found: [...run.found, ...more.entries.filter((e) => OUTBOUND.has(e.kind)).flatMap((e) => secrets(e.text))] };
  cache.set(id, run);
  return run;
}

/** @typedef {import('../../autopilot/transcript.js').Entry} Entry @typedef {import('../../watch/widgets.js').Paint} Paint */

/** A bold coloured kind, then dim details. @param {Paint} c @param {string} color @param {string} kind @param {string} [rest] */
const label = (c, color, kind, rest = '') => `${c(`1;${color}`, kind)}${rest ? ` ${rest}` : ''}`;

/** Indent a body two columns (colour inside the indent, so wrapping keeps it). @param {string[]} ls @param {Paint} [c] @param {string} [code] */
const body = (ls, c, code) => ls.map((l) => (l ? `  ${c && code ? c(code, l) : l}` : ''));

/** At most RESULT_LINES lines unless full results are on. @param {string[]} ls @param {Record<string, any>} ui @param {Paint} c */
function capped(ls, ui, c) {
  return !ui.fullResults && ls.length > RESULT_LINES ? [...ls.slice(0, RESULT_LINES), c('2', `… ${ls.length - RESULT_LINES} more lines (o)`)] : ls;
}

/**
 * A tool call as what the agent did: single-line arguments beside the tool, a shell command as
 * `$ …` on its own lines, other multi-line text (file contents, edits) as an indented block.
 * @param {Entry} e @param {string} at @param {Record<string, any>} ui @param {Paint} c
 */
function callLines(e, at, ui, c) {
  const name = `← ${e.tool ?? 'tool'}`;
  let args;
  try {
    args = JSON.parse(e.text);
  } catch {
    // not JSON: shown as is
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [label(c, '33', name, at), ...body(capped(e.text.split('\n'), ui, c)), ''];
  /** @type {string[]} */
  const inline = [];
  /** @type {string[]} */
  const blocks = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'command' && typeof v === 'string') {
      const [first, ...more] = v.split('\n');
      blocks.unshift(...body([`$ ${first}`, ...capped(more, ui, c).map((l) => `  ${l}`)]));
    } else if (typeof v === 'string' && v.includes('\n')) blocks.push(...body([c('2', k), ...capped(v.split('\n'), ui, c).map((l) => `  ${l}`)]));
    else inline.push(`${c('2', k)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return [label(c, '33', name, [at, ...inline].filter(Boolean).join('  ')), ...blocks, ''];
}

/** What one entry shows, before wrapping. @param {Entry} e @param {Record<string, any>} ui @param {Paint} c @returns {string[]} */
export function entryLines(e, ui, c) {
  // toTimeString: plain hh:mm:ss (toLocaleTimeString adds a narrow no-break space and AM/PM)
  const at = e.at ? c('2', new Date(e.at).toTimeString().slice(0, 8)) : '';
  if ((e.kind === 'reply' || e.kind === 'thinking') && !e.text.trim()) return []; // nothing said: no bare label
  if (e.kind === 'prompt') return [label(c, '36', '→ PROMPT', at), ...body(e.text.split('\n')), ''];
  if (e.kind === 'sent') return [label(c, '36', '→ SENT by the harness', at), ...body(e.text.split('\n')), ''];
  if (e.kind === 'thinking') return ui.hideThinking ? [] : [label(c, '35', '← THINKING', at), ...body(e.text.split('\n'), c, '2'), ''];
  if (e.kind === 'reply') return [label(c, '32', '← REPLY', at), ...body(e.text.split('\n')), ''];
  if (e.kind === 'call') return callLines(e, at, ui, c);
  if (e.kind === 'result') {
    const kind = `→ ${e.error ? 'ERROR' : 'RESULT'}${e.tool ? ` ${e.tool}` : ''}`;
    return [label(c, e.error ? '31' : '36', kind, [at, c('2', `${num(e.text.length)} chars`)].filter(Boolean).join('  ')), ...body(capped(e.text.split('\n'), ui, c)), ''];
  }
  return []; // endpoint: shown in the header
}

/** Wrapped height per entry, for the width and toggles it was measured at. @type {WeakMap<Entry, { key: string, h: number }>} */
const heights = new WeakMap();

/** @param {Entry} e @param {number} w @param {string} flags @param {Record<string, any>} ui @param {Paint} c */
function heightOf(e, w, flags, ui, c) {
  const key = `${w}:${flags}`;
  const hit = heights.get(e);
  if (hit?.key === key) return hit.h;
  // plain wrap, not the memo: measuring the whole run must not hold every line in memory
  const h = entryLines(e, ui, c).reduce((n, l) => n + wrap(l, w).length, 0);
  heights.set(e, { key, h });
  return h;
}

/** Header numbers, per entries array (a new one whenever the run grows). @type {WeakMap<Entry[], { sentChars: number, endpoints: string[], results: number }>} */
const sums = new WeakMap();

/** @param {Entry[]} entries */
function totals(entries) {
  let t = sums.get(entries);
  if (!t) {
    const out = entries.filter((e) => OUTBOUND.has(e.kind));
    t = { sentChars: out.reduce((n, e) => n + e.text.length, 0), endpoints: [...new Set(entries.filter((e) => e.kind === 'endpoint').map((e) => e.text))], results: entries.filter((e) => e.kind === 'result').length };
    sums.set(entries, t);
  }
  return t;
}

/**
 * Every message to and from the model, per agent run, as it happens: prompt, thinking, replies,
 * tool calls and the tool output sent back; with where it was sent and anything that looks like a secret.
 * @type {import('../app.js').Screen}
 */
export const transcriptScreen = {
  id: 'transcript',
  title: 'Transcript',
  load(ctx, ui) {
    if (!ui.imported) {
      ui.imported = true;
      importLastRun(ctx.root);
    }
    const runs = listRuns(ctx.root);
    // every agent running now: the serial one, or one per parallel worker
    const status = readStatus(ctx.root);
    const agents = [status?.agent, ...(status?.parallel?.running ?? []).map((w) => readStatus(ctx.root, w.id)?.agent)].filter((a) => a?.transcript);
    /** @type {Map<string, NonNullable<typeof agents[number]>>} */
    const live = new Map(agents.map((a) => [/** @type {any} */ (a).transcript, /** @type {any} */ (a)]));
    // follow the newest live run until the user picks another
    const newest = runs.findIndex((r) => live.has(r.id));
    if (ui.pinned === undefined && newest >= 0) ui.at = newest;
    ui.at = moveIn(ui.at ?? 0, 0, runs.length);
    ui.follow ??= true;
    const run = runs[ui.at];
    return { runs, run, data: run ? load(ctx.root, run.id) : null, agent: run ? live.get(run.id) ?? null : null, live, liveId: newest >= 0 ? runs[newest].id : undefined };
  },
  keys(d, ui) {
    return [
      { key: '↑↓', label: 'run' },
      { key: 'pgup/dn', label: 'scroll' },
      { key: 'f', label: ui.follow ? 'following' : 'follow' },
      { key: 't', label: ui.hideThinking ? 'show thinking' : 'hide thinking' },
      { key: 'o', label: ui.fullResults ? 'short results' : 'full results' },
      ...(d.liveId ? [{ key: 'l', label: 'jump to live' }] : []),
    ];
  },
  render(d, ui, w, h, c) {
    const rows = d.runs.map((/** @type {{ id: string, role: string, at: string }} */ r) => {
      const found = cache.get(r.id)?.found.length;
      return `${d.live.has(r.id) ? c('33', '●') : ' '} ${r.role}  ${c('2', r.at ? `${age(Date.now() - Date.parse(r.at))} ago` : '')}${found ? c('31', `  ⚠ ${found}`) : ''}`;
    });
    if (!d.run) return [` ${c('2', 'no agent runs yet')}`];
    const { entries, found } = /** @type {NonNullable<typeof d.data>} */ (d.data);
    const live = d.live.has(d.run.id);
    const { sentChars, endpoints, results } = totals(entries);
    /** @type {string[]} */
    const head = [
      `${c('1', d.run.role)}${live ? c('33', '  ● live') : ''}`,
      `sent to   ${endpoints.length ? endpoints.join(', ') : c('2', 'not reported')}`,
      `outbound  ${num(sentChars)} chars ≈ ${num(sentChars / 4)} tokens (prompt + ${results} tool results)`,
      ...(found.length ? [c('31', `⚠ ${found.length} possible secret(s) sent: ${found.map((/** @type {any} */ f) => `${f.kind} ${f.preview}`).join(', ')}`)] : [c('32', '✓ no secrets found in outbound')]),
      c('2', 'not shown: the agent CLI\'s system prompt and tool definitions'),
      c('2', '→ sent to the model   ← from the model'),
      '',
    ];
    const streaming = d.agent?.liveOf === 'reply';
    const tail = live && d.agent?.live && !(ui.hideThinking && !streaming) ? [label(c, streaming ? '32' : '35', streaming ? '← REPLY' : '← THINKING', c('2', 'streaming…')), ...body(d.agent.live.split('\n'), c, streaming ? '' : '2')] : [];
    const flags = `${ui.hideThinking ? 1 : 0}${ui.fullResults ? 1 : 0}`;
    const eager = (/** @type {string[]} */ ls, /** @type {number} */ pw) => {
      const out = ls.flatMap((l) => wrapped(l, pw));
      return { h: out.length, lines: () => out };
    };
    // one block per entry; only the blocks on screen are built and wrapped
    const detail = (/** @type {number} */ pw) =>
      pane([
        eager(head, pw),
        ...entries.map((/** @type {Entry} */ e) => ({ h: heightOf(e, pw, flags, ui, c), lines: () => entryLines(e, ui, c).flatMap((l) => wrapped(l, pw)) })),
        eager(tail, pw),
      ]);
    return listDetail({ title: 'Agent runs', rows, at: ui.at, detailTitle: 'Model traffic', detail, scroll: ui.follow ? Number.MAX_SAFE_INTEGER : ui.scroll, clamped: (s) => (ui.scroll = s) }, w, h, c);
  },
  handle(key, d, ui) {
    const pick = (/** @type {number} */ by) => {
      ui.at = moveIn(ui.at, by, d.runs.length);
      ui.pinned = true;
      ui.scroll = 0;
      ui.follow = d.live.has(d.runs[ui.at]?.id);
    };
    if (key === 'up' || key === 'k') pick(-1);
    else if (key === 'down' || key === 'j') pick(1);
    else if (key === 'pgdn' || key === 'pgup') {
      // render keeps ui.scroll at the real position, so leaving follow mode starts from where the view is
      ui.follow = false;
      ui.scroll = Math.max(0, (ui.scroll ?? 0) + (key === 'pgdn' ? 15 : -15));
    } else if (key === 'home') ((ui.follow = false), (ui.scroll = 0));
    else if (key === 'end' || key === 'f') ui.follow = key === 'end' ? true : !ui.follow;
    else if (key === 't') ui.hideThinking = !ui.hideThinking;
    else if (key === 'o') ui.fullResults = !ui.fullResults;
    else if (key === 'l' && d.liveId) ((ui.pinned = undefined), (ui.follow = true));
  },
};
