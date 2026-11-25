import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Validate a value against the subset of JSON Schema used by schema/*.json.
 * The schema files are the single source of truth for both editors and the CLI.
 * @param {any} schema
 * @param {unknown} value
 * @param {string} [at]
 * @returns {string[]}
 */
export function validate(schema, value, at = '$') {
  /** @type {string[]} */
  const errors = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const typeOk = schema.type === type || (schema.type === 'integer' && Number.isInteger(value));
  if (schema.type && !typeOk) return [`${at}: expected ${schema.type}, got ${type}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  if (type === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${at}: missing "${key}"`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validate(sub, v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown key "${key}"`);
    }
  }
  if (type === 'array' && schema.items) {
    /** @type {unknown[]} */ (value).forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  return errors;
}

/** @type {Map<string, any>} */
const loaded = new Map();

/** @param {'wololo.config' | 'rule' | 'rubric'} name */
export function loadSchema(name) {
  let s = loaded.get(name);
  if (!s) {
    s = JSON.parse(readFileSync(fileURLToPath(new URL(`../../schema/${name}.schema.json`, import.meta.url)), 'utf8'));
    loaded.set(name, s);
  }
  return s;
}
