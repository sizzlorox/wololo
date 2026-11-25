import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** MCP config files that agent CLIs read, relative to the repo root. */
export const MCP_FILES = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.gemini/settings.json'];

/**
 * Remote servers pasted as `claude mcp add name <url> -t http -H ...` often end up as a stdio `command`,
 * which agents then try to spawn ("os error 123" on Windows). Say exactly what the entry should be.
 * Secrets in the original args are replaced by an env var placeholder, never echoed.
 * @param {string} file
 * @param {any} config
 * @returns {string[]}
 */
export function mcpProblems(file, config) {
  const servers = config?.mcpServers ?? config?.servers ?? {};
  /** @type {string[]} */
  const problems = [];
  for (const [name, server] of Object.entries(servers)) {
    if (typeof server?.command !== 'string' || !/^https?:\/\//i.test(server.command)) continue;
    /** @type {string[]} */
    const args = Array.isArray(server.args) ? server.args.map(String) : [];
    /** @type {Record<string, string>} */
    const headers = {};
    args.forEach((arg, i) => {
      if (!['-H', '--header'].includes(arg) || !args[i + 1]?.includes(':')) return;
      const key = args[i + 1].slice(0, args[i + 1].indexOf(':')).trim();
      const env = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${/auth/i.test(key) ? 'API_KEY' : key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
      headers[key] = /auth/i.test(key) ? `Bearer \${${env}}` : `\${${env}}`;
    });
    const entry = { type: 'http', url: server.command, ...(Object.keys(headers).length ? { headers } : {}) };
    problems.push(`${file}: "${name}" has a URL as its command, so agents try to run it as a program. Use ${JSON.stringify(entry)} and set the env var(s) it names.`);
  }
  return problems;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function checkMcpFiles(root) {
  return MCP_FILES.filter((f) => existsSync(join(root, f))).flatMap((f) => {
    try {
      return mcpProblems(f, JSON.parse(readFileSync(join(root, f), 'utf8')));
    } catch {
      return []; // JSONC (comments) or hand-edited: the agent CLI reports its own parse errors
    }
  });
}
