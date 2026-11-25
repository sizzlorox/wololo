/**
 * Terminal input for the TUI: raw key bytes to names, and a small form editor. Pure, so tests drive it directly.
 */

/** @type {Record<string, string>} */
const NAMED = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn', '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end',
  '\x1b[Z': 'backtab', '\t': 'tab', '\r': 'enter', '\n': 'enter', '\x1b': 'esc', '\x7f': 'backspace', '\b': 'backspace',
  '\x03': 'ctrl-c', '\x1b[3~': 'delete',
};

/**
 * One chunk from stdin can hold several keys (fast typing, pastes): split it into key names.
 * Printable text comes back one character per key.
 * @param {string} chunk
 * @returns {string[]}
 */
export function decode(chunk) {
  /** @type {string[]} */
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    const seq = Object.keys(NAMED).filter((k) => k !== '\x1b' && chunk.startsWith(k, i)).sort((a, b) => b.length - a.length)[0];
    const unknown = /^\x1b(\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(chunk.slice(i));
    if (seq) {
      keys.push(NAMED[seq]);
      i += seq.length;
    } else if (unknown) {
      i += unknown[0].length; // an escape sequence we do not use (F-keys, modifiers): drop it, never read it as esc + text
    } else if (chunk[i] === '\x1b') {
      keys.push('esc');
      i++;
    } else {
      const ch = chunk[i++];
      if (ch >= ' ') keys.push(ch);
    }
  }
  return keys;
}

/**
 * @typedef {object} Field
 * @property {string} name
 * @property {string} label
 * @property {string} value
 * @property {string} [hint]
 * @property {boolean} [required]
 *
 * @typedef {object} Form
 * @property {string} title
 * @property {Field[]} fields
 * @property {number} at       the field being edited
 * @property {string} [error]
 */

/** @typedef {Omit<Field, 'value'> & { value?: string }} FieldSpec */

/** @param {string} title @param {FieldSpec[]} fields @returns {Form} */
export const form = (title, fields) => ({ title, fields: fields.map((f) => ({ ...f, value: f.value ?? '' })), at: 0 });

/**
 * Apply one key. Tab/↓ next field, shift-tab/↑ previous, enter next or submit on the last field, esc cancels.
 * @param {Form} f
 * @param {string} key
 * @returns {{ form: Form, submit?: Record<string, string>, cancel?: boolean }}
 */
export function editForm(f, key) {
  const fields = f.fields.map((x) => ({ ...x }));
  const cur = fields[f.at];
  const next = { ...f, fields, error: undefined };
  if (key === 'esc') return { form: f, cancel: true };
  if (key === 'tab' || key === 'down') return { form: { ...next, at: Math.min(fields.length - 1, f.at + 1) } };
  if (key === 'backtab' || key === 'up') return { form: { ...next, at: Math.max(0, f.at - 1) } };
  if (key === 'enter') {
    if (f.at < fields.length - 1) return { form: { ...next, at: f.at + 1 } };
    const missing = fields.find((x) => x.required && !x.value.trim());
    if (missing) return { form: { ...next, at: fields.indexOf(missing), error: `${missing.label} is required` } };
    return { form: next, submit: Object.fromEntries(fields.map((x) => [x.name, x.value])) };
  }
  if (key === 'backspace') cur.value = cur.value.slice(0, -1);
  else if (key.length === 1) cur.value += key;
  return { form: next };
}
