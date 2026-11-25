/**
 * Minimal frontmatter for SKILL.md / agent files: flat `key: value` pairs only.
 * @param {string} text
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  /** @type {Record<string, string>} */
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    data[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: text.slice(m[0].length) };
}

/**
 * @param {Record<string, string | undefined>} data
 * @param {string} body
 */
export function stringifyFrontmatter(data, body) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${needsQuote(/** @type {string} */ (v)) ? JSON.stringify(v) : v}`);
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

/** @param {string} v */
function needsQuote(v) {
  return /^[\s'"[{>|*&!%@`#-]|: |#|\s$/.test(v);
}
