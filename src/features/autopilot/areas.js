// Which files a step changes ("touches"): shared by the parallel scheduler and learned-skill triggers.

/** The fixed part of a path or glob: `src/**\/*.rs` → `src`. @param {string} p */
export const prefix = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').split('*')[0].replace(/\/+$/, '');

/**
 * Can two steps' areas collide? A dir contains its files; globs compare by their fixed prefix;
 * a step that declared nothing may touch anything.
 * @param {string[]} a @param {string[]} b
 */
export function overlaps(a, b) {
  if (!a.length || !b.length) return true;
  const within = (/** @type {string} */ x, /** @type {string} */ y) => x === y || !y || x.startsWith(`${y}/`);
  return a.some((x) => b.some((y) => within(prefix(x), prefix(y)) || within(prefix(y), prefix(x))));
}
