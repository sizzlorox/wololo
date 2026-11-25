/** @typedef {import('./types.js').OptionSpec} OptionSpec */
/** @typedef {import('./types.js').PositionalSpec} PositionalSpec */

/** @param {string} s */
export function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** @param {string} s */
export function kebab(s) {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Coerce a raw value to the declared option type. Shared by CLI and MCP so both behave identically.
 * @param {OptionSpec} spec
 * @param {unknown} raw
 * @returns {unknown}
 */
export function coerce(spec, raw) {
  switch (spec.type) {
    case 'boolean':
      return raw === true || raw === 'true' || raw === '1' || raw === 'yes';
    case 'number': {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`expected a number, got "${String(raw)}"`);
      return n;
    }
    case 'string[]':
      if (Array.isArray(raw)) return raw.map(String);
      return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    default:
      return String(raw);
  }
}

/**
 * Parse argv against option and positional specs.
 * @param {string[]} argv
 * @param {Record<string, OptionSpec>} options
 * @param {PositionalSpec[]} positionals
 * @returns {{ values: Record<string, any>, errors: string[] }}
 */
export function parseArgs(argv, options, positionals) {
  /** @type {Record<string, any>} */
  const values = {};
  const errors = [];
  /** @type {string[]} */
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      rest.push(token);
      continue;
    }
    let [flag, inline] = /** @type {[string, string | undefined]} */ (splitOnce(token.slice(2), '='));
    let negate = false;
    if (!(camel(flag) in options) && flag.startsWith('no-') && camel(flag.slice(3)) in options) {
      flag = flag.slice(3);
      negate = true;
    }
    const key = camel(flag);
    const spec = options[key];
    if (!spec) {
      errors.push(`unknown option --${flag}`);
      continue;
    }
    if (spec.type === 'boolean') {
      values[key] = negate ? false : inline === undefined ? true : coerce(spec, inline);
      continue;
    }
    const raw = inline ?? argv[++i];
    if (raw === undefined) {
      errors.push(`option --${flag} needs a value`);
      continue;
    }
    try {
      const v = coerce(spec, raw);
      values[key] = spec.type === 'string[]' ? [...(values[key] ?? []), .../** @type {string[]} */ (v)] : v;
    } catch (e) {
      errors.push(`--${flag}: ${/** @type {Error} */ (e).message}`);
    }
  }

  positionals.forEach((p, idx) => {
    if (p.variadic) values[p.name] = rest.slice(idx);
    else if (rest[idx] !== undefined) values[p.name] = rest[idx];
    else if (p.required) errors.push(`missing argument <${p.name}>`);
  });
  const max = positionals.some((p) => p.variadic) ? Infinity : positionals.length;
  if (rest.length > max) errors.push(`unexpected argument "${rest[max]}"`);

  for (const [key, spec] of Object.entries(options)) {
    if (values[key] === undefined && spec.default !== undefined) values[key] = spec.default;
  }
  return { values, errors };
}

/**
 * @param {string} s
 * @param {string} sep
 */
function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i === -1 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}
