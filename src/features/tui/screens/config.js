import { join } from 'node:path';
import { loadConfig } from '../../../core/config.js';
import { readJson } from '../../../core/files.js';
import { loadSchema } from '../../../core/schema.js';
import { saveSettings } from '../settings.js';
import { listDetail, moveIn } from '../layout.js';

const FILE = 'wololo.config.json';

/**
 * Leaves of a config object as dotted paths; arrays are leaves (edited as JSON).
 * @param {any} obj @param {string} [prefix]
 * @returns {[string, any][]}
 */
export function flatten(obj, prefix = '') {
  return Object.entries(obj ?? {}).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? flatten(v, path) : [[path, v]];
  });
}

/** @param {any} schema @param {string} path */
const schemaAt = (schema, path) => path.split('.').reduce((s, k) => s?.properties?.[k] ?? (s?.additionalProperties && typeof s.additionalProperties === 'object' ? s.additionalProperties : undefined), schema);

/** @param {any} obj @param {string} path */
const getAt = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

/** Typed text to a value: JSON when it parses (numbers, booleans, arrays, objects), otherwise the string. @param {string} text */
export const parseValue = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Edit wololo.config.json: every effective setting, where it comes from, its schema description; validated before saving.
 * @type {import('../app.js').Screen}
 */
export const configScreen = {
  id: 'config',
  title: 'Config',
  load(ctx, ui) {
    const raw = readJson(join(ctx.root, FILE), /** @type {any} */ ({}));
    let effective;
    let error = '';
    try {
      effective = loadConfig(ctx.root);
    } catch (e) {
      effective = raw;
      error = /** @type {Error} */ (e).message;
    }
    const rows = flatten(effective).filter(([k]) => k !== 'root');
    ui.at = moveIn(ui.at ?? 0, 0, rows.length);
    return { raw, rows, error, schema: loadSchema('wololo.config') };
  },
  keys(d, ui) {
    const [path] = d.rows[ui.at] ?? [];
    return [{ key: '↑↓', label: 'setting' }, { key: 'e', label: 'edit' }, ...(path && getAt(d.raw, path) !== undefined ? [{ key: 'u', label: 'reset to default' }] : [])];
  },
  render(d, ui, w, h, c) {
    const rows = d.rows.map((/** @type {[string, any]} */ [k, v]) => `${getAt(d.raw, k) === undefined ? c('2', '·') : c('33', '●')} ${k} ${c('2', '=')} ${JSON.stringify(v)}`);
    const [path, value] = d.rows[ui.at] ?? [];
    const s = path ? schemaAt(d.schema, path) : undefined;
    const detail = path
      ? [
          c('1', path),
          getAt(d.raw, path) === undefined ? c('2', 'default') : c('33', 'set in wololo.config.json'),
          '',
          ...JSON.stringify(value, null, 2).split('\n'),
          '',
          ...(s?.description ? [s.description] : []),
          ...(s?.type ? [c('2', `type: ${s.type}${s.enum ? ` (one of ${s.enum.join(', ')})` : ''}`)] : []),
          '',
          c('2', 'e edit · JSON (8, true, ["a"]) or text · checked against the schema on save'),
        ]
      : [];
    return [...(d.error ? [c('31', ` ${d.error.split('\n').join(' ')}`)] : [` ${c('2', `${FILE} · ● set in the file · default`)}`]), ...listDetail({ title: 'Settings', rows, at: ui.at, detailTitle: 'Setting', detail }, w, h - 1, c)];
  },
  handle(key, d, ui, app) {
    if (key === 'up' || key === 'k') return void (ui.at = moveIn(ui.at, -1, d.rows.length));
    if (key === 'down' || key === 'j') return void (ui.at = moveIn(ui.at, 1, d.rows.length));
    const [path, value] = d.rows[ui.at] ?? [];
    if (!path) return;
    /** @param {unknown} next */
    const save = (next) => saveSettings(app.ctx.root, { [path]: next });
    if (key === 'e' || key === 'enter') return app.ask(`Edit ${path}`, [{ name: 'value', label: 'Value', value: typeof value === 'string' ? value : JSON.stringify(value) }], (f) => save(parseValue(f.value)));
    if (key === 'u' && getAt(d.raw, path) !== undefined) return app.confirm(`Remove ${path} from ${FILE} (back to the default)?`, () => save(undefined));
  },
};

