import { join } from 'node:path';
import { readJson, writeJson } from '../../core/files.js';
import { loadSchema, validate } from '../../core/schema.js';
import { CONFIG_FILE } from '../../core/state.js';

/**
 * Set (or with `undefined`, remove) a dotted path, creating objects on the way; emptied parents are pruned.
 * @param {any} obj @param {string} path @param {unknown} value
 */
export function setAt(obj, path, value) {
  const keys = path.split('.');
  const copy = structuredClone(obj ?? {});
  let o = copy;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  if (value === undefined) delete o[/** @type {string} */ (keys.at(-1))];
  else o[/** @type {string} */ (keys.at(-1))] = value;
  for (let i = keys.length - 1; i > 0; i--) {
    const parent = keys.slice(0, i).reduce((x, k) => x?.[k], copy);
    if (parent && typeof parent === 'object' && !Object.keys(parent).length) delete keys.slice(0, i - 1).reduce((x, k) => x[k], copy)[keys[i - 1]];
  }
  return copy;
}

/**
 * Write settings into wololo.config.json, all or nothing, only if the result passes the schema.
 * Running autopilot rereads the file before each agent, so changes apply to the next agent.
 * @param {string} root
 * @param {Record<string, unknown>} changes  dotted path → value (undefined removes it)
 * @returns {string} what happened, for the status line
 */
export function saveSettings(root, changes) {
  const file = join(root, CONFIG_FILE);
  const raw = Object.entries(changes).reduce((o, [path, value]) => setAt(o, path, value), readJson(file, {}));
  const errors = validate(loadSchema('wololo.config'), raw);
  if (errors.length) return `not saved: ${errors.join('; ')}`;
  writeJson(file, raw);
  return Object.entries(changes)
    .map(([path, value]) => (value === undefined ? `${path} reset to default` : `${path} = ${JSON.stringify(value)}`))
    .join(', ');
}
