/** @type {Map<string, RegExp>} */
const cache = new Map();

/**
 * Convert a glob to a RegExp. Supports `**`, `*`, `?` and `{a,b}`. Paths are always repo-relative with `/`.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup = true;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

/**
 * @param {string} path
 * @param {string | string[] | undefined} globs
 */
export function matchAny(path, globs) {
  if (!globs) return false;
  const list = Array.isArray(globs) ? globs : [globs];
  return list.some((g) => globToRegExp(g).test(path));
}
