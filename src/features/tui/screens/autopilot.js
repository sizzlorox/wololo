import { act, keys as runKeys, selectedTask } from '../../watch/actions.js';
import { details, render } from '../../watch/render.js';
import { view } from '../../watch/view.js';
import { loadConfig } from '../../../core/config.js';
import { readRuns } from '../../autopilot/usage.js';
import { ADAPTERS } from '../../../adapters/index.js';
import { saveSettings } from '../settings.js';

/** Claude Code takes these aliases as well as full model ids. */
const ALIASES = /** @type {Record<string, string[]>} */ ({ claude: ['opus', 'sonnet', 'haiku'] });

/**
 * The agent autopilot drives, the model set for it, and models worth suggesting: aliases, then
 * every model a past run reported, newest first.
 * @param {string} root
 */
export function modelChoice(root) {
  let config;
  try {
    config = loadConfig(root);
  } catch {
    return { agent: '', model: '', seen: [], settable: false };
  }
  const agent = config.autopilot.agent;
  const seen = [...new Set([...(ALIASES[agent] ?? []), ...readRuns(root).reverse().map((e) => e.model).filter((m) => typeof m === 'string' && m)])];
  return { agent, model: config.autopilot.models?.[agent] ?? '', seen, settable: Boolean(ADAPTERS[agent]?.model) && !config.autopilot.command?.length };
}

/** The live run: plan, agent, repo, stats, feed. Keys retry, redo, skip, add, switch plans, start and stop. */
/** @type {import('../app.js').Screen} */
export const autopilot = {
  id: 'autopilot',
  title: 'Autopilot',
  load(ctx, ui) {
    const v = view(ctx.root, { width: 0, height: 0, color: true }, ui);
    ui.selected = selectedTask(v)?.id;
    return { ...v, selected: ui.selected, choice: modelChoice(ctx.root) };
  },
  keys(v, ui) {
    if (ui.details) return [{ key: 'esc', label: 'back' }];
    const c = v.choice;
    return [...runKeys(v).filter((k) => k.key !== 'q'), ...(c.agent ? [{ key: 'm', label: `${c.agent}: ${c.model || 'default model'}` }] : [])];
  },
  render(v, ui, w, h) {
    const t = selectedTask(v);
    if (ui.details && t) return details(t, w, h).split('\n');
    ui.details = false;
    return render({ ...v, width: w, height: h, color: true }).split('\n');
  },
  async handle(key, v, ui, app) {
    if (ui.details) {
      if (key === 'esc' || key === 'enter') ui.details = false;
      return;
    }
    const i = v.tasks.findIndex((/** @type {any} */ t) => t.id === ui.selected);
    if (key === 'up' || key === 'k') ui.selected = v.tasks[Math.max(0, i - 1)]?.id ?? ui.selected;
    else if (key === 'down' || key === 'j') ui.selected = v.tasks[Math.min(v.tasks.length - 1, i + 1)]?.id ?? ui.selected;
    else if (key === 'enter') ui.details = Boolean(selectedTask(v));
    else if (key === 'g' && (v.groups?.length ?? 0) > 1) {
      ui.group = v.groups[(v.groups.indexOf(v.group ?? v.status?.group ?? '') + 1) % v.groups.length];
      ui.selected = undefined;
    } else {
      const ctx = { ...app.ctx, launch: app.launch };
      if (key === 'n') return app.ask('New goal: plan it, then build it step by step', [{ name: 'goal', label: 'Goal', required: true }], (f) => act('n', v, ctx, f.goal));
      if (key === 'a') return app.ask(`Add a step after "${selectedTask(v)?.title ?? 'the end'}"`, [{ name: 'title', label: 'Step', required: true }], (f) => act('a', v, ctx, f.title));
      if (key === 'm') {
        const c = v.choice;
        if (!c.settable) return `${c.agent} has no model flag here (or autopilot.command is set): pick its model in its own config`;
        return app.ask(`Model for autopilot runs (${c.agent})`, [
          { name: 'agent', label: 'Agent', value: c.agent, hint: Object.keys(ADAPTERS).filter((a) => ADAPTERS[a].headless).join(' | ') },
          { name: 'model', label: 'Model', value: c.model, hint: c.seen.length ? c.seen.slice(0, 8).join(' | ') : 'blank = the agent\'s default' },
        ], (f) => {
          const agent = f.agent.trim() || c.agent;
          if (!ADAPTERS[agent]?.headless) return `unknown agent "${agent}"`;
          const msg = saveSettings(app.ctx.root, { 'autopilot.agent': agent, [`autopilot.models.${agent}`]: f.model.trim() || undefined });
          return v.alive && !msg.startsWith('not saved') ? `${msg} (the next agent uses it)` : msg;
        });
      }
      if (key === 'x') return app.confirm('Stop the running autopilot and its agent?', () => act('x', v, ctx));
      return act(key, v, ctx);
    }
  },
};
