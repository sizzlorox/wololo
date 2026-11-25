/** Drawing pieces for `wololo watch`: everything measures visible width, so ANSI colors never break the layout. */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** @param {string} s */
export const width = (s) => s.replace(ANSI, '').length;

/** Truncate by visible characters; a cut line loses its colors rather than leak them. @param {string} s @param {number} w */
export function fit(s, w) {
  if (w <= 0) return '';
  const plain = s.replace(ANSI, '');
  return plain.length > w ? `${plain.slice(0, w - 1)}…` : s;
}

/** Fit, then pad with spaces to exactly `w` visible characters. @param {string} s @param {number} w */
export const pad = (s, w) => {
  const f = fit(s, w);
  return f + ' '.repeat(Math.max(0, w - width(f)));
};

/** @typedef {(code: string, s: string) => string} Paint */

/** @param {boolean} color @returns {Paint} */
export const painter = (color) => (code, s) => (color && s ? `\x1b[${code}m${s}\x1b[0m` : s);

/**
 * A gauge like `██████░░░░`, green → yellow → red as it fills.
 * @param {number} fraction @param {number} w @param {Paint} c
 */
export function bar(fraction, w, c) {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const full = Math.round(f * w);
  return c(f < 0.6 ? '32' : f < 0.85 ? '33' : '31', '█'.repeat(full)) + c('2', '░'.repeat(w - full));
}

/**
 * A titled, rounded panel exactly `w` wide, at least `rows` tall.
 * @param {string} title @param {string[]} body @param {number} w @param {Paint} c @param {number} [rows]
 */
export function box(title, body, w, c, rows = 0) {
  const inner = w - 4;
  const name = fit(title, Math.max(0, w - 6));
  const top = c('2', '╭─ ') + c('1', name) + c('2', ` ${'─'.repeat(Math.max(0, w - 5 - width(name)))}╮`);
  const lines = [...body];
  while (lines.length < rows - 2) lines.push('');
  return [top, ...lines.map((l) => `${c('2', '│')} ${pad(l, inner)} ${c('2', '│')}`), c('2', `╰${'─'.repeat(w - 2)}╯`)];
}

/** Lay columns of lines side by side; each column is `widths[i]` wide. @param {string[][]} cols @param {number[]} widths */
export function columns(cols, widths) {
  const rows = Math.max(...cols.map((col) => col.length));
  return Array.from({ length: rows }, (_, i) => cols.map((col, j) => col[i] ?? ' '.repeat(widths[j])).join(''));
}

/** `1 call`, `3 calls`. @param {number} n @param {string} word */
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
