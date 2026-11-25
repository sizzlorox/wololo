import { age } from '../../../core/text.js';
import { readStatus } from '../../autopilot/status.js';
import { alive } from '../../watch/view.js';
import { readRuns, summarize } from '../../autopilot/usage.js';
import { bar, box, columns, pad } from '../../watch/widgets.js';
import { listDetail, moveIn, num, usd } from '../layout.js';

/** @param {number[]} xs */
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** ▁▂▃▅▇ of each turn's prompt size: how the context grew over a run. @param {number[]} xs @param {number} w */
export function spark(xs, w) {
  if (!xs.length) return '';
  const step = Math.max(1, Math.ceil(xs.length / w));
  const pts = [];
  for (let i = 0; i < xs.length; i += step) pts.push(Math.max(...xs.slice(i, i + step)));
  const max = Math.max(...pts) || 1;
  return pts.map((x) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((x / max) * 7.999))]).join('');
}

/**
 * Tokens: totals, prompt sizes (median, max), cache hit rate and savings, per role, and per agent run.
 * @type {import('../app.js').Screen}
 */
export const usage = {
  id: 'usage',
  title: 'Usage',
  load(ctx, ui) {
    // ponytail: rereads every run file each frame; cache on mtime if a long-lived repo makes it slow
    const all = readRuns(ctx.root);
    // agents running right now: a run still marked live but not among them stopped without finishing (a crash)
    // a run that died leaves its last status behind: only a live process has agents running
    const st = readStatus(ctx.root);
    const status = st && st.state === 'running' && alive(st.pid) ? st : null;
    const active = new Set([status?.agent?.transcript, ...(status?.parallel?.running ?? []).map((w) => readStatus(ctx.root, w.id)?.agent?.transcript)].filter(Boolean));
    const runs = all.map((r) => ({ ...r, state: r.live ? (active.has(r.id) ? 'live' : 'stopped') : r.killed ? 'killed' : 'done' })).reverse();
    ui.at = moveIn(ui.at ?? 0, 0, runs.length);
    return { s: summarize(all), runs, live: status?.agent ?? null };
  },
  keys(d) {
    return d.runs.length ? [{ key: '↑↓', label: 'run' }] : [];
  },
  render(d, ui, w, h, c) {
    const { s } = d;
    if (!s.runs) return [` ${c('2', 'no agent runs yet')}`];
    const t = s.total;
    const sent = t.input + t.cacheRead + t.cacheWrite;
    const cached = t.cacheRead + t.cacheWrite > 0;
    const half = w >= 100 ? Math.floor(w / 2) : w;
    const totals = [
      `${pad('runs', 14)}${s.runs} agent runs · ${t.turns} turns`,
      `${pad('prompt tokens', 14)}${num(sent)} sent (${num(t.input)} fresh · ${num(t.cacheRead)} cache read · ${num(t.cacheWrite)} cache write)`,
      `${pad('output tokens', 14)}${num(t.output)}`,
      // a server that never reports cached tokens shows 0: say so instead of a misleading 0%
      `${pad('cache hits', 14)}${cached ? `${bar(s.hitRate, 20, c)} ${Math.round(s.hitRate * 100)}% of prompt tokens` : c('2', 'not reported by the model server')}`,
      `${pad('saved', 14)}${num(t.cacheRead)} tokens from cache${t.saved ? ` · ${usd(t.saved)}` : ''}`,
      `${pad('cost', 14)}${t.cost ? usd(t.cost) : c('2', 'not reported')}`,
    ];
    const prompts = [
      `${pad('median turn', 14)}${num(s.medianContext)} tokens`,
      `${pad('largest turn', 14)}${num(s.maxContext)} tokens`,
      `${pad('wololo prompt', 14)}median ${num(s.medianPromptChars)} chars ≈ ${num(s.medianPromptChars / 4)} tokens`,
      ...(d.live?.usage ? ['', c('33', `running now · ${d.live.role}`), `${pad('', 14)}in ${num(d.live.usage.input + d.live.usage.cacheRead + d.live.usage.cacheWrite)} · out ${num(d.live.usage.output)} · ${d.live.usage.turns} turns`] : []),
    ];
    const top = w >= 100 ? columns([box('Totals', totals, half, c), box('Prompt size', prompts, w - half, c, totals.length + 2)], [half, w - half]) : [...box('Totals', totals, w, c), ...box('Prompt size', prompts, w, c)];
    const roleRows = s.roles.map((/** @type {any} */ r) => `${pad(r.role, 14)}${pad(`${r.runs} runs`, 10)}${pad(`${num(r.input + r.cacheRead + r.cacheWrite)} in`, 12)}${pad(`${num(r.output)} out`, 12)}${cached && r.input + r.cacheRead ? `${Math.round((100 * r.cacheRead) / (r.input + r.cacheRead + r.cacheWrite))}% cached` : ''}${r.cost ? `  ${usd(r.cost)}` : ''}`);
    const roles = box('By role', roleRows, w, c);
    const mark = /** @type {Record<string, string>} */ ({ live: c('33', '●'), stopped: c('31', '✗'), killed: c('31', '✗'), done: ' ' });
    const rows = d.runs.map((/** @type {any} */ r) => `${mark[r.state]} ${pad(r.role.split(' (')[0], 12)} ${pad(r.turns ? num(r.input + r.cacheRead + r.cacheWrite) : '—', 7)} ${pad(`${r.turns}t`, 5)} ${c('2', `${age(Date.now() - Date.parse(r.ts))} ago`)}${r.state === 'killed' ? c('31', ` killed: ${r.killed}`) : r.state === 'stopped' ? c('31', ' stopped without finishing') : ''}`);
    const r = d.runs[ui.at];
    const ctxs = /** @type {number[]} */ (r?.contexts ?? []);
    const detail = r
      ? [
          c('1', r.role),
          `${new Date(r.ts).toLocaleString()} · ${r.turns} turns${r.model ? ` · ${r.model}` : ''} · ${r.state === 'live' ? c('33', 'running') : r.state === 'killed' ? c('31', `killed: ${r.killed}`) : r.state === 'stopped' ? c('31', 'stopped without finishing') : 'finished'}`,
          ...(r.turns ? [] : [c('2', 'no token usage reported yet')]),
          '',
          `prompt sent   ${num(r.input + r.cacheRead + r.cacheWrite)} (${num(r.input)} fresh · ${num(r.cacheRead)} cached · ${num(r.cacheWrite)} written)`,
          `output        ${num(r.output)}`,
          `cache hits    ${r.cacheRead + r.cacheWrite ? `${Math.round((100 * r.cacheRead) / (r.input + r.cacheRead + r.cacheWrite))}%` : 'not reported'}`,
          ...(r.cost ? [`cost          ${usd(r.cost)}${r.saved ? ` (cache saved ${usd(r.saved)})` : ''}`] : []),
          `wololo prompt ${num(r.promptChars ?? 0)} chars`,
          '',
          `turn size     min ${num(ctxs.length ? Math.min(...ctxs) : 0)} · median ${num(med(ctxs))} · max ${num(ctxs.length ? Math.max(...ctxs) : 0)}`,
          c('36', spark(ctxs, 60)),
          c('2', 'context per turn'),
        ]
      : [];
    const used = top.length + roles.length;
    return [...top, ...roles, ...listDetail({ title: 'Agent runs, newest first', rows, at: ui.at, detailTitle: 'Run', detail }, w, Math.max(6, h - used), c)].slice(0, h);
  },
  handle(key, d, ui) {
    if (key === 'up' || key === 'k') ui.at = moveIn(ui.at, -1, d.runs.length);
    if (key === 'down' || key === 'j') ui.at = moveIn(ui.at, 1, d.runs.length);
  },
};
