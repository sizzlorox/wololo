import { bar, box, columns, fit, pad, painter, plural, width } from './widgets.js';
import { blockReason } from '../board/store.js';
import { wrap as wrapText } from '../tui/layout.js';

/**
 * Render one frame of `wololo watch`. Pure: everything it shows comes in through `view`, so the
 * same code serves the live TUI and the `--once` snapshot.
 *
 * @typedef {object} View
 * @property {import('../autopilot/status.js').Status | null} status
 * @property {import('../board/store.js').Task[]} tasks   the run's group, in plan order
 * @property {boolean} alive        the autopilot process is still running
 * @property {string} [git]         progress of the current agent run, from git
 * @property {number} now           epoch ms
 * @property {number} width
 * @property {number} height
 * @property {boolean} color
 * @property {string} [selected]    task id under the cursor
 * @property {string} [group]       plan being shown, when not the run's own
 * @property {string[]} [groups]    every plan on the board
 * @property {{ id: string, title: string, started: string, dir: string, status: import('../autopilot/status.js').Status | null }[]} [workers]  parallel run: one per step building now
 * @property {import('../board/inbox.js').Message[]} [inbox]  what the agents told each other
 * @property {number} [toReview]  sampled commits waiting to be tasted
 */

/** @param {number} ms */
export function duration(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : m ? `${m}m` : `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/** @param {number} n */
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Panels sit side by side from this many columns. */
const WIDE = 110;
const GAUGE = 20;
const MARK = { done: '✓', claimed: '▶', blocked: '✗', todo: '·' };
/** @type {Record<string, string>} */
const MARK_COLOR = { '✓': '32', '▶': '33', '✗': '31', '·': '2', '⑂': '35' };
const NOT_ROLES = /^(gate |killed: |landed|split$|stopped$)/;

/** @param {string} label @param {import('./widgets.js').Paint} c */
const row = (label, c) => c('2', label.padEnd(8));

/** @param {View} v */
export function render(v) {
  const c = painter(v.color);
  const s = v.status;
  if (!s) return fit('no run yet · n new goal', v.width);
  const dead = s.state === 'running' && !v.alive;
  const stats = s.stats ?? {};

  const badge = dead ? c('31', '✗ not running') : s.state === 'running' ? c('33', '● running') : s.state === 'landed' ? c('32', '✓ landed') : c('31', `✗ ${s.state}`);
  const facts = [s.agentCli, s.model && `model ${s.model}`, s.workers !== undefined && (s.workers > 1 ? `parallel ×${s.workers}` : 'serial (autopilot.workers = 1)'), s.version && `v${s.version}`, s.contextWindow && `${k(s.contextWindow)} ctx`, `pid ${s.pid}`, `up ${duration(v.now - Date.parse(s.started))}`, v.toReview ? c('33', `${v.toReview} to review`) : ''].filter(Boolean);
  const left = ` ${c('1', 'WOLOLO AUTOPILOT')}  ${badge}  ${facts.join('  ')}`;
  const right = 'q quit ';
  const gap = v.width - width(left) - right.length;
  const head = gap > 0 ? left + ' '.repeat(gap) + right : pad(left, v.width);
  const top = [v.color ? `\x1b[7m${head}\x1b[0m` : head.trimEnd()];
  if (dead) top.push(c('31', ` killed or crashed; press r to resume ${s.group ?? ''}`.trimEnd()));
  if (s.goal) top.push(` ${c('2', 'goal')}  ${s.goal.replace(/\s+/g, ' ')}`);
  if (s.summary && s.state !== 'running') top.push(` ${c('2', 'ended')} ${s.summary}`);

  const wide = v.width >= WIDE;
  const half = Math.floor(v.width / 2);
  const planW = wide ? half : v.width;
  const sideW = wide ? v.width - half : v.width;
  const plan = v.tasks.length ? planBody(v, c, planW - 4, Math.max(3, Math.min(12, Math.floor(v.height / 3)))) : null;
  const par = s.parallel;
  const side = [
    ...(par && (v.workers?.length || par.queue.length)
      ? [box(`Workers · ${v.workers?.length ?? 0}/${par.workers} → ${par.main}`, workersBody(v, c, sideW - 4), sideW, c), ...(par.queue.length ? [box('Merge queue', par.queue.map((q, i) => `${i ? c('2', '·') : c('33', '▶')} ${q.title}  ${c(/conflict|fails|waiting/.test(q.state) ? '31' : '2', q.state)}`), sideW, c)] : [])]
      : [box(s.agent ? `Agent · ${s.agent.role}` : 'Agent', agentBody(v, c, dead), sideW, c)]),
    box('Repo', repoBody(v, c), sideW, c),
    box('Run', runBody(stats), sideW, c),
  ];

  /** @type {string[]} */
  let panels;
  if (wide && plan) {
    const sideH = side.reduce((n, b) => n + b.length, 0);
    const planBox = box(`Plan · ${v.group ?? s.group ?? ''}`, plan, planW, c, sideH);
    const last = side.length - 1;
    side[last] = box('Run', runBody(stats), sideW, c, side[last].length + Math.max(0, planBox.length - sideH));
    panels = columns([planBox, side.flat()], [planW, sideW]);
  } else panels = [...(plan ? box(`Plan · ${v.group ?? s.group ?? ''}`, plan, planW, c) : []), ...side.flat()];

  const lines = [...top, ...panels];
  // what the parallel agents said to each other
  // what is waiting on you, with why and what to press: a blocked step is the one thing autopilot cannot do
  const stuck = v.tasks.filter((t) => t.status === 'blocked');
  if (stuck.length) {
    const body = stuck.slice(0, 4).flatMap((t) => [`${c('31', '✗')} ${c('1', t.title)}`, ...wrapText(blockReason(t) || `blocked on ${t.blockedOn ?? '?'}`, v.width - 8).map((l) => `  ${l}`)]);
    if (stuck.length > 4) body.push(c('2', `… ${stuck.length - 4} more on the Board tab`));
    body.push(c('2', 'r retry · s skip · enter details (pick the step with ↑↓) · Board tab: e edit the step'));
    lines.push(...box(`Needs you · ${stuck.length} blocked`, body, v.width, c));
  }
  const said = (v.inbox ?? []).filter((m) => m.from !== 'wololo' || /merged|started/.test(m.text));
  if (said.length && v.height - lines.length > 12) {
    const n = Math.min(said.length, Math.max(3, Math.floor((v.height - lines.length) / 3)));
    lines.push(...box('Messages between agents', said.slice(-n).map((m) => `${c('2', new Date(m.at).toTimeString().slice(0, 8))} ${m.from === 'wololo' ? c('36', 'wololo') : c('33', m.title)}: ${m.text}`), v.width, c));
  }
  const room = v.height - lines.length - 2;
  if (room > 0 && s.activity.length) {
    const feed = s.activity.slice(-room).map((a) => `${c('2', new Date(a.at).toTimeString().slice(0, 8))} ${tint(a.line, c)}`);
    lines.push(...box('Activity', feed, v.width, c));
  }
  return lines
    .slice(0, v.height)
    .map((l) => fit(l, v.width))
    .join('\n');
}

/** @param {string} line @param {import('./widgets.js').Paint} c */
function tint(line, c) {
  if (line.startsWith('»')) return c('36', line);
  if (/\b(error|failed|FAIL|killed|timed out)\b/i.test(line)) return c('31', line);
  if (/^(edit|write|patch|apply_patch|create)\b/i.test(line)) return c('32', line);
  if (/^(bash|shell|run)\b/i.test(line)) return c('34', line);
  if (/^(read|grep|glob|find|ls|search)\b/i.test(line)) return c('2', line);
  if (/^(compacting|context compacted)/.test(line)) return c('35', line);
  return line;
}

/** @param {View} v @param {import('./widgets.js').Paint} c @param {number} inner @param {number} room */
function planBody(v, c, inner, room) {
  const s = /** @type {import('../autopilot/status.js').Status} */ (v.status);
  const stats = s.stats ?? {};
  const steps = v.tasks.filter((t) => !t.splitInto?.length);
  const done = steps.filter((t) => t.status === 'done').length;
  const pct = Math.round((100 * done) / Math.max(1, steps.length));
  const body = [`${bar(done / Math.max(1, steps.length), Math.max(10, Math.min(30, inner - 24)), c)} ${done}/${steps.length} landed · ${pct}%`];
  const left = steps.filter((t) => t.status === 'todo' || t.status === 'claimed').length;
  if (stats.landed && left) {
    const per = stats.landedMs / stats.landed;
    body.push(c('2', `~${duration(per * left)} left (${duration(per)}/step)`));
  }
  const cursor = v.tasks.findIndex((t) => t.id === v.selected);
  const current = v.tasks.findIndex((t) => t.id === s.task?.id);
  const firstOpen = v.tasks.findIndex((t) => t.status !== 'done');
  const focus = cursor >= 0 ? cursor : current >= 0 ? current : Math.max(0, firstOpen);
  const from = Math.max(0, Math.min(focus - 2, v.tasks.length - room));
  if (from > 0) body.push(c('2', `… ${from} earlier`));
  for (const t of v.tasks.slice(from, from + room)) {
    const now = t.status !== 'done' && (t.id === s.task?.id || Boolean(v.workers?.some((w) => w.id === t.id))) && s.state === 'running' && v.alive;
    const mark = t.splitInto?.length ? '⑂' : now ? '▶' : MARK[t.status];
    const indent = '  '.repeat(t.splitDepth ?? 0);
    let tail = '';
    if (t.splitInto?.length) tail = c('2', `  split into ${t.splitInto.length}`);
    else if (t.status === 'blocked') tail = c('31', `  ${blockReason(t) || `blocked on ${t.blockedOn ?? '?'}`}`);
    else if (s.parallel?.waiting?.[t.id] && v.alive) tail = c('2', `  ${s.parallel.waiting[t.id]}`);
    else if (now && s.task?.started) tail = c('33', `  ${duration(v.now - Date.parse(s.task.started))}`);
    const pick = t.id === v.selected;
    body.push(`${indent}${pick ? c('1', '› ') : '  '}${c(MARK_COLOR[mark], mark)} ${pick ? c('1', t.title) : t.title}${tail}`);
  }
  const rest = v.tasks.length - from - room;
  if (rest > 0) body.push(c('2', `… ${rest} more`));
  return body;
}

/** @param {View} v @param {import('./widgets.js').Paint} c @param {boolean} dead */
function agentBody(v, c, dead) {
  const s = /** @type {import('../autopilot/status.js').Status} */ (v.status);
  const a = s.agent;
  if (!a || dead) return [c('2', s.state === 'running' && !dead ? 'between agents' : 'no agent running')];
  const body = [];
  if (s.task) body.push(`${row('task', c)}${s.task.title}`);
  const ran = v.now - Date.parse(a.started);
  body.push(`${row('time', c)}${a.timeoutMinutes > 0 ? `${bar(ran / (a.timeoutMinutes * 60_000), GAUGE, c)} ${duration(ran)} / ${a.timeoutMinutes}m` : duration(ran)}`);
  if (a.tokens && s.contextWindow) {
    const f = a.tokens / s.contextWindow;
    body.push(`${row('context', c)}${bar(f, GAUGE, c)} ${k(a.tokens)} / ${k(s.contextWindow)} ${Math.round(100 * f)}%`);
  } else if (a.tokens) body.push(`${row('context', c)}${k(a.tokens)} tokens`);
  if (a.idleSince) {
    const idle = v.now - Date.parse(a.idleSince);
    body.push(`${row('idle', c)}${s.stallMinutes ? `${bar(idle / (s.stallMinutes * 60_000), GAUGE, c)} ${duration(idle)} / ${s.stallMinutes}m` : duration(idle)}`);
  }
  if (a.calls !== undefined) body.push(`${row('tools', c)}${plural(a.calls, 'call')} · ${plural(a.edits ?? 0, 'edit')} · ${plural(a.compactions ?? 0, 'compaction')}`);
  if (s.phase) body.push(`${row('step', c)}${s.phase}`);
  if (a.usage) {
    const u = a.usage;
    const sent = u.input + u.cacheRead + u.cacheWrite;
    body.push(`${row('tokens', c)}in ${k(sent)} · out ${k(u.output)}${sent ? ` · cache ${Math.round((100 * u.cacheRead) / sent)}%` : ''}${u.cost ? ` · ${u.cost.toFixed(u.cost >= 1 ? 2 : 4)}` : ''}`);
  }
  if (a.live) body.push(`${row(a.liveOf === 'reply' ? 'writes' : 'thinks', c)}${c('2', a.live.replace(/\s+/g, ' ').slice(-200))}`);
  if (a.error) body.push(`${row('server', c)}${c('31', a.error)}`);
  return body;
}

/** @param {View} v @param {import('./widgets.js').Paint} c */
function repoBody(v, c) {
  const s = /** @type {import('../autopilot/status.js').Status} */ (v.status);
  const body = [`${row('git', c)}${v.git ?? c('2', '—')}`];
  if (s.gate) {
    const green = s.gate.startsWith('green');
    const age = s.gateAt ? c('2', `  ${duration(v.now - Date.parse(s.gateAt))} ago`) : '';
    body.push(`${row('gate', c)}${c(green ? '32' : '31', `${green ? '✓' : '✗'} ${s.gate}`)}${age}`);
  } else body.push(`${row('gate', c)}${c('2', 'not run yet')}`);
  return body;
}

/** @param {Record<string, number>} stats */
function runBody(stats) {
  /** @param {[string, number][]} pairs */
  const list = (pairs) =>
    pairs
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} ${n}`)
      .join(' · ');
  const all = Object.entries(stats);
  const body = [];
  const agents = list(all.filter(([key]) => !NOT_ROLES.test(key)));
  if (agents) body.push(`${'agents'.padEnd(8)}${agents}`);
  if (stats['gate green'] || stats['gate red']) body.push(`${'gates'.padEnd(8)}${stats['gate green'] ?? 0} green · ${stats['gate red'] ?? 0} red`);
  const kills = list(all.filter(([key]) => key.startsWith('killed: ')).map(([key, n]) => [key.slice(8), n]));
  if (kills) body.push(`${'kills'.padEnd(8)}${kills}`);
  const steps = [['landed', stats.landed], ['split', stats.split], ['stopped', stats.stopped]].filter(([, n]) => n).map(([w, n]) => `${n} ${w}`);
  if (steps.length) body.push(`${'steps'.padEnd(8)}${steps.join(' · ')}`);
  return body.length ? body : ['nothing yet'];
}

/**
 * Full-screen view of one step: what it asks for, its state, and its notes (newest last, trimmed to fit).
 * @param {import('../board/store.js').Task} t
 * @param {number} w
 * @param {number} h
 */
export function details(t, w, h, scroll = 0) {
  const state = t.status === 'blocked' ? `blocked on ${t.blockedOn ?? '?'}` : t.status;
  const why = t.status === 'blocked' ? blockReason(t) : '';
  const wrapped = (/** @type {string} */ s, indent = ' ') => wrapText(s, w - indent.length).map((l) => `${indent}${l}`);
  const lines = [
    ...wrapped(t.title),
    ...wrapped(`${state} · ${t.id}${t.agent ? ` · ${t.agent}` : ''}`),
    ...(why ? wrapped(`blocked: ${why}`) : []),
    ...(t.deps?.length ? wrapped(`needs: ${t.deps.join(', ')}`) : []),
    ...(t.touches?.length ? wrapped(`changes: ${t.touches.join(', ')}`) : []),
    '',
    ...wrapped(t.body || '(no description)'),
    // newest first: the latest notes are the ones that matter, right under the description
    ...(t.notes.length ? ['', ' notes, newest first:', ...[...t.notes].reverse().flatMap((n) => wrapped(n, '  '))] : []),
  ];
  const room = Math.max(1, h - 2);
  const from = Math.max(0, Math.min(scroll, lines.length - room));
  const shown = lines.slice(from, from + room);
  const more = from + room < lines.length;
  const foot = ['', ` esc back${from > 0 || more ? ` · pgup/pgdn scroll${more ? ` (${lines.length - from - room} more lines)` : ''}` : ''}`];
  return [...shown, ...foot].map((l) => fit(l, w)).join('\n');
}

/** One block per parallel worker: its step, agent, time, tokens and what it is thinking. @param {View} v @param {import('./widgets.js').Paint} c @param {number} inner */
function workersBody(v, c, inner) {
  const ws = v.workers ?? [];
  const blocks = ws.flatMap((w) => {
    const a = w.status?.agent;
    const u = a?.usage;
    const sent = u ? u.input + u.cacheRead + u.cacheWrite : 0;
    return [
      `${c('33', '▶')} ${c('1', w.title)}`,
      `  ${c('2', a ? `${a.role} · ${duration(v.now - Date.parse(a.started))}${a.calls ? ` · ${plural(a.calls, 'call')}` : ''}${u ? ` · in ${k(sent)} out ${k(u.output)}` : ''}` : `between agents · ${duration(v.now - Date.parse(w.started))}`)}`,
      ...(a?.live ? [`  ${c('2', `${a.liveOf === 'reply' ? 'writes' : 'thinks'}: ${a.live.replace(/\s+/g, ' ').slice(-(inner - 12))}`)}`] : []),
    ];
  });
  // idle workers say why: a step waiting on a dep or a shared file looks like a broken run otherwise
  const par = v.status?.parallel;
  const idle = (par?.workers ?? 0) - ws.length;
  const waiting = Object.values(par?.waiting ?? {});
  const why = [];
  if (idle > 0 && waiting.length) {
    const shared = waiting.filter((w) => w.startsWith('shares ')).length;
    const deps = waiting.filter((w) => w.startsWith('needs ')).length;
    why.push(c('2', `${idle} idle: ${[shared && `${shared} step(s) share files with running work`, deps && `${deps} wait for a dep to merge`].filter(Boolean).join(', ') || 'nothing else can start yet'}`));
  }
  if (par?.hotspot) why.push(c('33', `${par.hotspot.file} is changed by ${par.hotspot.steps} open steps, so they run one at a time. A registry there (each system registers itself) would let them run in parallel.`));
  return [...(ws.length ? blocks : [c('2', par?.queue.length ? 'merging' : 'no step can start')]), ...why];
}
