import { createHash } from 'node:crypto';

const STOP = new Set(
  'the and for are but not you your with this that from have has had was were will would should could can cant dont into onto then than them they their there here what when where which while who why how all any each just also its it\'s our out about over under again more most some such only own same very too use used using get got make made please thanks thank let lets need needs want'.split(
    ' ',
  ),
);

/** @param {string} text */
export function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Single-link clustering by token overlap. Deterministic: output order follows input order.
 * @template T
 * @param {T[]} items
 * @param {(t: T) => string} text
 * @param {number} threshold
 * @returns {T[][]}
 */
export function cluster(items, text, threshold) {
  const toks = items.map((i) => tokenize(text(i)));
  const parent = items.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (jaccard(toks[i], toks[j]) >= threshold) parent[find(j)] = find(i);
    }
  }
  /** @type {Map<number, T[]>} */
  const groups = new Map();
  items.forEach((item, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), item]);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** @param {string} s */
export function shortHash(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

/** @param {string} s */
export function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * @param {string} s
 * @param {number} n
 */
export function truncate(s, n) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Keep the last `n` lines of output: failures are almost always at the end.
 * @param {string} s
 * @param {number} n
 */
export function tail(s, n) {
  const lines = s.trimEnd().split('\n');
  return lines.length > n ? [`… (${lines.length - n} lines omitted)`, ...lines.slice(-n)].join('\n') : lines.join('\n');
}

/**
 * @param {number} ms
 */
export function age(ms) {
  const h = ms / 36e5;
  return h < 1 ? `${Math.round(ms / 6e4)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}
