import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { statePath } from '../../../core/state.js';
import { age } from '../../../core/text.js';
import { readStatus } from '../../autopilot/status.js';
import { importLastRun, listRuns, readRunFrom, secrets } from '../../autopilot/transcript.js';
import { listDetail, moveIn, num } from '../layout.js';

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
    const sentChars = entries.filter((/** @type {any} */ e) => OUTBOUND.has(e.kind)).reduce((/** @type {number} */ n, /** @type {any} */ e) => n + e.text.length, 0);
    const endpoints = [...new Set(entries.filter((/** @type {any} */ e) => e.kind === 'endpoint').map((/** @type {any} */ e) => e.text))];
    /** @type {string[]} */
    const lines = [
      `${c('1', d.run.role)}${live ? c('33', '  ● live') : ''}`,
      `sent to   ${endpoints.length ? endpoints.join(', ') : c('2', 'not reported')}`,
      `outbound  ${num(sentChars)} chars ≈ ${num(sentChars / 4)} tokens (prompt + ${entries.filter((/** @type {any} */ e) => e.kind === 'result').length} tool results)`,
      ...(found.length ? [c('31', `⚠ ${found.length} possible secret(s) sent: ${found.map((/** @type {any} */ f) => `${f.kind} ${f.preview}`).join(', ')}`)] : [c('32', '✓ no secrets found in outbound')]),
      c('2', 'not shown: the agent CLI\'s system prompt and tool definitions'),
      '',
    ];
    const label = (/** @type {string} */ color, /** @type {string} */ text) => c(color, `── ${text} ${'─'.repeat(Math.max(0, 40 - text.length))}`);
    for (const e of entries) {
      const at = e.at ? c('2', ` ${new Date(e.at).toLocaleTimeString()}`) : '';
      if (e.kind === 'endpoint') continue;
      if (e.kind === 'prompt') lines.push(label('36', '→ PROMPT  wololo → model') + at, e.text, '');
      else if (e.kind === 'sent') lines.push(label('36', '→ SENT  harness → model') + at, e.text, '');
      else if (e.kind === 'thinking') {
        if (!ui.hideThinking) lines.push(label('35', '← THINKING') + at, c('2', e.text), '');
      } else if (e.kind === 'reply') lines.push(label('32', '← REPLY') + at, e.text, '');
      else if (e.kind === 'call') lines.push(label('33', `← TOOL CALL  ${e.tool}`) + at, e.text, '');
      else if (e.kind === 'result') {
        const body = e.text.split('\n');
        const cut = !ui.fullResults && body.length > RESULT_LINES;
        lines.push(label(e.error ? '31' : '36', `→ TOOL RESULT  ${e.tool ?? ''} ${num(e.text.length)} chars, sent to the model${e.error ? ' (error)' : ''}`) + at, ...(cut ? [...body.slice(0, RESULT_LINES), c('2', `… ${body.length - RESULT_LINES} more lines (o)`)] : body), '');
      }
    }
    if (live && d.agent?.live && !(ui.hideThinking && d.agent.liveOf === 'thinking')) lines.push(label(d.agent.liveOf === 'reply' ? '32' : '35', `← ${d.agent.liveOf === 'reply' ? 'REPLY' : 'THINKING'}  streaming…`), d.agent.liveOf === 'reply' ? d.agent.live : c('2', d.agent.live));
    return listDetail({ title: 'Agent runs', rows, at: ui.at, detailTitle: 'Model traffic', detail: lines, scroll: ui.follow ? Number.MAX_SAFE_INTEGER : ui.scroll, clamped: (s) => (ui.scroll = s) }, w, h, c);
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
