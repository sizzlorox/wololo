import { kebab } from '../../../core/args.js';
import { listDetail, moveIn } from '../layout.js';

/** Commands with a screen of their own, or that only make sense for machines. */
const HIDDEN = /^(hook|watch|tui|mcp)\b/;

/**
 * Form values to argv: positionals in order (a variadic one splits on spaces), then --options.
 * Booleans take y/yes/true; lists take commas; blanks are left out.
 * @param {import('../../../core/types.js').Command} cmd
 * @param {Record<string, string>} values
 */
export function argvFor(cmd, values) {
  const argv = cmd.name.split(' ');
  for (const a of cmd.args ?? []) {
    const v = (values[`arg:${a.name}`] ?? '').trim();
    if (v) argv.push(...(a.variadic ? v.split(/\s+/) : [v]));
  }
  for (const [name, o] of Object.entries(cmd.options ?? {})) {
    const v = (values[name] ?? '').trim();
    if (!v) continue;
    if (o.type === 'boolean') {
      if (/^(y|yes|true|1)$/i.test(v)) argv.push(`--${kebab(name)}`);
    } else argv.push(`--${kebab(name)}`, v);
  }
  return argv;
}

/**
 * Every wololo command: read what it does and its options, fill them in, run it, read the full result.
 * @param {import('../../../core/types.js').Command[]} all
 * @returns {import('../app.js').Screen}
 */
export function commandsScreen(all) {
  const list = all.filter((c) => !HIDDEN.test(c.name));
  return {
    id: 'commands',
    title: 'Commands',
    load(_ctx, ui) {
      const q = (ui.filter ?? '').toLowerCase();
      const shown = list.filter((c) => !q || c.name.includes(q) || c.summary.toLowerCase().includes(q));
      ui.at = moveIn(ui.at ?? 0, 0, shown.length);
      return { shown, cmd: shown[ui.at] };
    },
    keys(d, ui) {
      return [{ key: '↑↓', label: 'command' }, ...(d.cmd ? [{ key: 'enter', label: 'run…' }] : []), { key: '/', label: ui.filter ? `filter: ${ui.filter}` : 'filter' }, ...(ui.result ? [{ key: 'pgup/dn', label: 'scroll result' }, { key: 'esc', label: 'clear result' }] : [])];
    },
    render(d, ui, w, h, c) {
      const rows = d.shown.map((/** @type {import('../../../core/types.js').Command} */ x) => x.name);
      /** @type {import('../../../core/types.js').Command | undefined} */
      const cmd = d.cmd;
      const r = ui.result;
      const usage = cmd
        ? [
            c('1', `wololo ${cmd.name}`),
            cmd.summary,
            ...((cmd.args ?? []).length ? ['', c('2', 'arguments'), ...(cmd.args ?? []).map((a) => `  ${a.name}${a.required ? '*' : ''}${a.variadic ? '…' : ''}  ${c('2', a.description)}`)] : []),
            ...(Object.keys(cmd.options ?? {}).length ? ['', c('2', 'options'), ...Object.entries(cmd.options ?? {}).map(([k, o]) => `  --${kebab(k)} <${o.type}>  ${c('2', `${o.description}${o.default !== undefined ? ` (default ${JSON.stringify(o.default)})` : ''}`)}`)] : []),
          ]
        : [];
      const result = r ? ['', c('2', '─'.repeat(20)), `${c('1', r.argv.join(' '))}  ${c('2', `${Math.round(r.ms / 100) / 10}s`)}`, r.ok ? c('32', r.summary) : c('31', r.summary), ...(r.details ?? []).flatMap((/** @type {string} */ x) => x.split('\n'))] : [];
      return listDetail({ title: 'Commands', rows, at: ui.at, detailTitle: r ? 'Result' : 'Usage', detail: [...(r ? result.slice(1) : usage)], scroll: ui.scroll }, w, h, c);
    },
    handle(key, d, ui, app) {
      if (key === 'up' || key === 'k') return void ((ui.at = moveIn(ui.at, -1, d.shown.length)), (ui.result = null), (ui.scroll = 0));
      if (key === 'down' || key === 'j') return void ((ui.at = moveIn(ui.at, 1, d.shown.length)), (ui.result = null), (ui.scroll = 0));
      if (key === 'pgdn') return void (ui.scroll = (ui.scroll ?? 0) + 10);
      if (key === 'pgup') return void (ui.scroll = Math.max(0, (ui.scroll ?? 0) - 10));
      if (key === 'esc') return void ((ui.result = null), (ui.scroll = 0));
      if (key === '/') return app.ask('Filter commands', [{ name: 'q', label: 'Name or words', value: ui.filter ?? '' }], (f) => void ((ui.filter = f.q.trim()), (ui.at = 0)));
      /** @type {import('../../../core/types.js').Command | undefined} */
      const cmd = d.cmd;
      if (key !== 'enter' || !cmd) return;
      const fields = [
        ...(cmd.args ?? []).map((a) => ({ name: `arg:${a.name}`, label: a.name, hint: a.description, required: a.required })),
        ...Object.entries(cmd.options ?? {}).map(([k, o]) => ({ name: k, label: `--${kebab(k)} (${o.type})`, hint: `${o.description}${o.default !== undefined ? ` [${JSON.stringify(o.default)}]` : ''}${o.type === 'boolean' ? ' · y/n' : ''}` })),
      ];
      const run = async (/** @type {Record<string, string>} */ values) => {
        const argv = argvFor(cmd, values);
        if (cmd.name === 'autopilot') {
          app.launch(argv);
          app.go('autopilot');
          return `started: wololo ${argv.join(' ')}`;
        }
        const started = Date.now();
        const r = await app.exec(argv);
        ui.result = { ...r, argv: ['wololo', ...argv], ms: Date.now() - started };
        ui.scroll = 0;
        return r.summary;
      };
      if (!fields.length) return run({});
      app.ask(`wololo ${cmd.name}`, fields, run);
    },
  };
}
