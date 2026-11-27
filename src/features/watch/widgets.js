/** Drawing pieces for `wololo watch`: everything measures visible width, so ANSI colors never break the layout. */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/**
 * Screen columns one character takes: 0 for combining marks and zero-width joiners, 2 for wide
 * East Asian characters and emoji, 1 otherwise. Counting characters instead made text with CJK or
 * emoji wider than measured, and it overflowed its panel.
 * @param {string} ch  one code point
 */
function cols(ch) {
  const c = /** @type {number} */ (ch.codePointAt(0));
  if (c < 0x300) return 1; // ASCII and Latin, nearly all text: skip the Unicode regex below
  if (c === 0x200d || c === 0xfe0f || (c >= 0x300 && c <= 0x36f) || (c >= 0x20d0 && c <= 0x20ff)) return 0;
  if (/\p{Extended_Pictographic}/u.test(ch) && c > 0x2bff) return 2;
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)) return 2;
  return 1;
}

/** Tabs as two spaces; other control characters (not ANSI escapes) dropped: they have no fixed width. @param {string} s */
export const clean = (s) => s.replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '');

/** Screen columns a string takes, ANSI colours not counted. @param {string} s */
export const width = (s) => {
  if (!/[^\x20-\x7e]/.test(s)) return s.length; // printable ASCII: one column each, no escapes or tabs
  let n = 0;
  for (const ch of clean(s).replace(ANSI, '')) n += cols(ch);
  return n;
};

/** The longest start of plain (uncoloured) text that fits in w columns. @param {string} plain @param {number} w */
export function cut(plain, w) {
  let out = '';
  let n = 0;
  for (const ch of plain) {
    const k = cols(ch);
    if (n + k > w) break;
    out += ch;
    n += k;
  }
  return out;
}

/** Truncate by screen columns; a cut line loses its colours rather than leak them. @param {string} s @param {number} w */
export function fit(s, w) {
  if (w <= 0) return '';
  const tidy = clean(s);
  if (width(tidy) <= w) return tidy;
  return `${cut(tidy.replace(ANSI, ''), w - 1)}…`;
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
