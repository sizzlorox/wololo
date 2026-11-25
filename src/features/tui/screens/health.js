import { age } from '../../../core/text.js';
import { readEvents } from '../../../core/state.js';
import { listDetail, moveIn } from '../layout.js';

/** What each key runs, in the order the footer shows them. */
const RUNS = [
  { key: 'g', label: 'gate', args: ['gate'] },
  { key: 'v', label: 'verify', args: ['verify'] },
  { key: 'V', label: 'verify --fast', args: ['verify', '--fast'] },
  { key: 'c', label: 'check', args: ['check'] },
  { key: 's', label: 'score', args: ['score'] },
  { key: 'd', label: 'doctor', args: ['doctor'] },
  { key: 'G', label: 'garden', args: ['garden'] },
];

/**
 * A command's details as items: an unindented line starts one, indented lines belong to it.
 * `PASS verify`, `✗ adapters drifted`, `src/a.js:3 no-debugger …` all become selectable rows.
 * @param {string[]} details
 * @returns {{ head: string, lines: string[] }[]}
 */
export function items(details) {
  /** @type {{ head: string, lines: string[] }[]} */
  const out = [];
  for (const line of details.flatMap((d) => d.split('\n'))) {
    if (!line.trim()) {
      out.at(-1)?.lines.push('');
      continue;
    }
    if (/^\s/.test(line) && out.length) out[out.length - 1].lines.push(line.replace(/^ {4}/, ''));
    else out.push({ head: line, lines: [] });
  }
  return out;
}

/**
 * Run the gate, verify, check, score, doctor and garden; drill into each part of the result.
 * @type {import('../app.js').Screen}
 */
export const health = {
  id: 'health',
  title: 'Health',
  load(ctx, ui) {
    const last = readEvents(ctx.root).filter((e) => e.type === 'gate').at(-1);
    const parts = ui.result ? items(ui.result.details ?? []) : [];
    ui.at = moveIn(ui.at ?? 0, 0, parts.length);
    return { last, parts };
  },
  keys(d) {
    return [...RUNS.map(({ key, label }) => ({ key, label })), ...(d.parts.length ? [{ key: '↑↓', label: 'part' }, { key: 'pgup/dn', label: 'scroll' }] : [])];
  },
  render(d, ui, w, h, c) {
    const paint = (/** @type {string} */ s) => (/^(PASS|✓)/.test(s) ? c('32', s) : /^(FAIL|✗|broken)/.test(s) || /\berror\b/.test(s) ? c('31', s) : s);
    const last = d.last ? `last gate ${d.last.ok ? c('32', 'PASS') : c('31', `BLOCKED by ${(d.last.failed ?? []).join(', ')}`)} ${age(Date.now() - Date.parse(d.last.ts))} ago` : 'gate not run yet';
    const r = ui.result;
    const head = r ? `${c('1', `wololo ${r.args.join(' ')}`)}: ${r.ok ? c('32', r.summary) : c('31', r.summary)} ${c('2', `(${Math.round(r.ms / 1000)}s)`)}` : c('2', 'no check run yet');
    const part = d.parts[ui.at];
    const detail = part ? [paint(part.head), '', ...(part.lines.length ? part.lines : [c('2', '(nothing more)')])] : [c('2', r ? 'no details' : '')];
    return [` ${last}`, ` ${head}`, ...listDetail({ title: 'Parts', rows: d.parts.map((/** @type {{ head: string }} */ p) => paint(p.head)), at: ui.at, detailTitle: 'Output', detail, scroll: ui.scroll }, w, h - 2, c)];
  },
  async handle(key, d, ui, app) {
    if (key === 'up' || key === 'k') return void ((ui.at = moveIn(ui.at, -1, d.parts.length)), (ui.scroll = 0));
    if (key === 'down' || key === 'j') return void ((ui.at = moveIn(ui.at, 1, d.parts.length)), (ui.scroll = 0));
    if (key === 'pgdn') return void (ui.scroll = (ui.scroll ?? 0) + 10);
    if (key === 'pgup') return void (ui.scroll = Math.max(0, (ui.scroll ?? 0) - 10));
    const run = RUNS.find((x) => x.key === key);
    if (!run) return;
    const started = Date.now();
    const r = await app.exec(run.args);
    ui.result = { ...r, args: run.args, ms: Date.now() - started };
    // land on the first failure: that is what you want to read
    ui.at = Math.max(0, items(r.details ?? []).findIndex((p) => /^(FAIL|✗|broken)/.test(p.head)));
    ui.scroll = 0;
    return `${run.label}: ${r.summary}`;
  },
};
