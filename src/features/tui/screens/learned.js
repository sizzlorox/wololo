import { loadConfig } from '../../../core/config.js';
import { age } from '../../../core/text.js';
import { readRuns } from '../../autopilot/usage.js';
import { listLearned, removeLearned, saveLearned } from '../../learn/store.js';
import { runSync } from '../../sync/command.js';
import { listDetail, moveIn } from '../layout.js';

const MARK = /** @type {Record<string, [string, string]>} */ ({ trial: ['33', '◐'], kept: ['32', '✓'], retired: ['2', '✗'] });

/**
 * Learned skills: what wololo saw agents repeat, what it wrote down, where it applies, and how the trial went.
 * @type {import('../app.js').Screen}
 */
export const learnedScreen = {
  id: 'learned',
  title: 'Learned',
  load(ctx, ui) {
    const items = listLearned(ctx.root).reverse();
    ui.at = moveIn(ui.at ?? 0, 0, items.length);
    let mode = 'auto';
    try {
      mode = loadConfig(ctx.root).autopilot.learn ?? 'auto';
    } catch {
      // invalid config: show the default
    }
    const runs = readRuns(ctx.root);
    const uses = (/** @type {string} */ id) => runs.filter((r) => /** @type {any} */ (r).learned?.includes(id));
    return { items, item: items[ui.at], mode, uses };
  },
  keys(d) {
    const i = d.item;
    if (!i) return [];
    return [
      { key: '↑↓', label: 'skill' },
      ...(i.status !== 'kept' ? [{ key: 'p', label: 'keep' }] : []),
      ...(i.status !== 'retired' ? [{ key: 'x', label: 'retire' }] : [{ key: 'u', label: 'back on trial' }]),
      { key: 'd', label: 'delete' },
    ];
  },
  render(d, ui, w, h, c) {
    const head = ` ${c('2', `autopilot.learn = ${d.mode}`)}${d.mode === 'off' ? c('2', ' · nothing is learned') : d.mode === 'suggest' ? c('2', ' · repeated workflows go to the Queue') : ''}`;
    if (!d.items.length) return [head, ` ${c('2', 'no learned skills yet')}`];
    const rows = d.items.map((/** @type {import('../../learn/store.js').Learned} */ i) => `${c(MARK[i.status][0], MARK[i.status][1])} ${i.title}  ${c('2', `${d.uses(i.id).length} uses`)}`);
    /** @type {import('../../learn/store.js').Learned} */
    const i = d.item;
    const used = d.uses(i.id);
    const turns = used.map((/** @type {any} */ r) => r.turns).filter(Boolean).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
    const detail = [
      c('1', i.title),
      `${c(MARK[i.status][0], i.status)} · ${i.kind} · learned ${age(Date.now() - Date.parse(i.created))} ago${i.reason ? ` · ${i.reason}` : ''}`,
      `for     ${i.trigger.roles.join(', ') || 'any role'} · ${i.trigger.files.join(', ') || 'any files'}`,
      `used    ${used.length} agent run(s)${turns.length ? `, median ${turns[Math.floor(turns.length / 2)]} turns` : ''} · before: ${i.evidence.baselineTurns || '?'} turns`,
      '',
      i.body,
      '',
      c('2', `learned from ${i.evidence.runs.length} runs across ${i.evidence.tasks.length} steps that all did:`),
      ...i.evidence.calls.map((x, n) => c('2', `  ${n + 1}. ${x}`)),
      '',
      c('2', `.wololo/learned/${i.id}/`),
    ];
    return [head, ...listDetail({ title: 'Learned skills', rows, at: ui.at, detailTitle: 'Skill', detail, scroll: ui.scroll }, w, h - 1, c)];
  },
  handle(key, d, ui, app) {
    if (key === 'up' || key === 'k') return void (ui.at = moveIn(ui.at, -1, d.items.length));
    if (key === 'down' || key === 'j') return void (ui.at = moveIn(ui.at, 1, d.items.length));
    if (key === 'pgdn') return void (ui.scroll = (ui.scroll ?? 0) + 10);
    if (key === 'pgup') return void (ui.scroll = Math.max(0, (ui.scroll ?? 0) - 10));
    /** @type {import('../../learn/store.js').Learned | undefined} */
    const i = d.item;
    if (!i) return;
    const root = app.ctx.root;
    const now = new Date().toISOString();
    /** @param {Partial<import('../../learn/store.js').Learned>} patch @param {string} msg */
    const set = (patch, msg) => {
      saveLearned(root, { ...i, ...patch });
      resync(app.ctx);
      return msg;
    };
    if (key === 'p' && i.status !== 'kept') return set({ status: 'kept', reason: 'kept by hand', decided: now }, `kept "${i.title}"`);
    if (key === 'x' && i.status !== 'retired') return set({ status: 'retired', reason: 'retired by hand', decided: now }, `retired "${i.title}"`);
    if (key === 'u' && i.status === 'retired') return set({ status: 'trial', reason: undefined, decided: undefined, created: now }, `"${i.title}" is back on trial`);
    if (key === 'd')
      return app.confirm(`Delete the learned skill "${i.title}"?`, () => {
        removeLearned(root, i.id);
        resync(app.ctx);
        return `deleted "${i.title}"`;
      });
  },
};

/** Claude Code's copies of learned skills are generated: keep them in sync, or the gate reports drift. @param {import('../../../core/types.js').Ctx} ctx */
function resync(ctx) {
  try {
    runSync({ ...ctx, config: loadConfig(ctx.root) }, {});
  } catch {
    // an invalid config: the Health tab will say so
  }
}
