import { box, clean, columns, cut, fit, pad, width } from '../watch/widgets.js';

/**
 * Shared TUI layout: a selectable list beside a detail pane, and wrapped text for details.
 */

/**
 * Keep a selection index in range after a move.
 * @param {number} at @param {number} by @param {number} n
 */
export const moveIn = (at, by, n) => (n ? Math.max(0, Math.min(n - 1, at + by)) : 0);

/**
 * Which slice of a list to show so the selection stays visible.
 * @param {number} n @param {number} at @param {number} room
 */
export function windowOf(n, at, room) {
  if (n <= room) return { from: 0, to: n };
  const from = Math.max(0, Math.min(at - Math.floor(room / 2), n - room));
  return { from, to: from + room };
}

/**
 * Word-wrap text to a width, keeping blank lines and indentation.
 * @param {string} text @param {number} w
 */
export function wrap(text, w) {
  if (w <= 4) return clean(text).split('\n');
  /** @type {string[]} */
  const out = [];
  for (const raw of clean(text).split('\n')) {
    const lead = /^\s*/.exec(raw)?.[0] ?? '';
    // indentation keeps at most half the width: wider, and no text would fit after it, forever
    const indent = lead.length <= w / 2 ? lead : ' '.repeat(Math.floor(w / 2));
    let rest = raw.slice(lead.length);
    if (!rest) {
      out.push('');
      continue;
    }
    while (width(indent + rest) > w) {
      const room = w - indent.length;
      const fits = cut(rest, room);
      const space = fits.lastIndexOf(' ');
      const at = space > fits.length / 3 ? space : fits.length || 1;
      out.push(indent + rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    out.push(indent + rest);
  }
  return out;
}

/** Wrapped lines by width, then text: a detail pane shows the same long transcript every frame. @type {Map<number, Map<string, string[]>>} */
const memo = new Map();

/** @param {string} line @param {number} w */
function wrapped(line, w) {
  let byText = memo.get(w);
  if (!byText) {
    memo.clear(); // a resize: the old width's lines are not coming back
    memo.set(w, (byText = new Map()));
  }
  let out = byText.get(line);
  if (!out) {
    // ponytail: drop everything past a bound instead of tracking recency; fine for one screen of history
    if (byText.size > 20000) byText.clear();
    byText.set(line, (out = wrap(line, w)));
  }
  return out;
}

/**
 * A list on the left, the selected item's details on the right; stacked when narrow.
 * @param {{ title: string, rows: string[], at: number, detailTitle: string, detail: string[], scroll?: number, clamped?: (scroll: number) => void }} p
 * @param {number} w @param {number} h @param {import('../watch/widgets.js').Paint} c
 * @returns {string[]}
 */
export function listDetail(p, w, h, c) {
  const wide = w >= 100;
  const listW = wide ? Math.max(30, Math.floor(w * 0.42)) : w;
  const detailW = wide ? w - listW : w;
  const listH = wide ? h : Math.max(5, Math.floor(h * 0.45));
  const detailH = wide ? h : h - listH;
  const room = Math.max(1, listH - 2);
  const { from, to } = windowOf(p.rows.length, p.at, room);
  const rows = p.rows.slice(from, to).map((r, i) => (from + i === p.at ? c('7', pad(`› ${r}`, listW - 4)) : `  ${r}`));
  if (!p.rows.length) rows.push(c('2', '(empty)'));
  const counter = p.rows.length ? ` ${p.at + 1}/${p.rows.length}` : '';
  const list = box(`${p.title}${counter}`, rows, listW, c, listH);
  const body = p.detail.flatMap((l) => wrapped(l, detailW - 4));
  const scroll = Math.max(0, Math.min(p.scroll ?? 0, body.length - (detailH - 2)));
  p.clamped?.(scroll);
  const shown = body.slice(scroll, scroll + detailH - 2);
  if (scroll + detailH - 2 < body.length) shown[shown.length - 1] = c('2', `… ${body.length - scroll - shown.length + 1} more lines (pgdn)`);
  const detail = box(p.detailTitle, shown, detailW, c, detailH);
  return (wide ? columns([list, detail], [listW, detailW]) : [...list, ...detail]).map((l) => fit(l, w));
}

/** `12.3k`, `4.5M`. @param {number} n */
export const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

/** @param {number} usd */
export const usd = (usd) => (usd >= 1 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(4)}` : '$0');
