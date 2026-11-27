import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRuns } from '../autopilot/usage.js';
import { readRun } from '../autopilot/transcript.js';
import { MCP_FILES } from '../doctor/mcp.js';

/**
 * Tools a step depends on (an MCP server: an image generator, a database, a design tool) must be
 * there before the step starts, and actually be used before it lands. Without both, an agent told
 * to "use the PixelLab MCP" that has no such tool writes a stand-in instead and calls it done.
 */

/** Words that sit next to "MCP" / "MCP server" in prose but are not a server's name. */
const NOT_NAMES = new Set(['the', 'a', 'an', 'this', 'that', 'your', 'our', 'its', 'any', 'via', 'with', 'use', 'using', 'own', 'same', 'remote', 'local', 'http', 'stdio', 'wololo', 'is', 'are', 'was', 'be', 'to', 'for', 'and', 'or', 'of', 'in', 'on', 'it', 'if', 'as', 'by', 'from', 'config', 'configured', 'tools', 'tool', 'servers', 'server', 'calls', 'call']);

const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * MCP servers a text says it needs: "the `pixellab` MCP server", "PixelLab MCP", "MCP server figma".
 * @param {string} text
 * @returns {string[]} lower-case names
 */
export function mcpMentions(text) {
  const found = new Set();
  for (const m of text.matchAll(/`?([A-Za-z][\w.-]*)`?\s+MCP\b/g)) if (!NOT_NAMES.has(m[1].toLowerCase())) found.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\bMCP\s+server\s+`?([A-Za-z][\w.-]*)`?/gi)) if (!NOT_NAMES.has(m[1].toLowerCase())) found.add(m[1].toLowerCase());
  return [...found];
}

/**
 * A goal plus the documents it points at (a BRIEF.md, a spec): requirements often live there.
 * @param {string} root @param {string} goal
 */
export function goalText(root, goal) {
  const docs = [...new Set(goal.match(/[\w./-]+\.(md|txt)\b/g) ?? [])].map((f) => join(root, f)).filter((f) => existsSync(f));
  return [goal, ...docs.map((f) => readFileSync(f, 'utf8'))].join('\n\n');
}

/**
 * Where each agent CLI reads MCP servers: files in the repo, and in the user's home. Only the agent
 * that will run counts: a server set up for Claude Code does nothing for omp, and one set up for
 * another project does nothing here (exactly how v-sim-v2 had "PixelLab configured" and no PixelLab).
 * @type {Record<string, { repo: string[], home: string[] }>}
 */
const MCP_SOURCES = {
  claude: { repo: ['.mcp.json'], home: ['.claude.json'] },
  omp: { repo: ['.mcp.json', '.omp/mcp.json'], home: ['.omp/agent/mcp.json'] },
  codex: { repo: ['.codex/config.toml'], home: ['.codex/config.toml'] },
  cursor: { repo: ['.cursor/mcp.json'], home: ['.cursor/mcp.json'] },
  gemini: { repo: ['.gemini/settings.json'], home: ['.gemini/settings.json'] },
  copilot: { repo: ['.vscode/mcp.json', '.mcp.json'], home: [] },
  opencode: { repo: ['opencode.json'], home: ['.config/opencode/opencode.json'] },
  amp: { repo: ['.amp/settings.json'], home: ['.config/amp/settings.json'] },
  windsurf: { repo: [], home: ['.codeium/windsurf/mcp_config.json'] },
};

const slash = (/** @type {string} */ p) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

/**
 * MCP servers the agent CLI will have when it runs in this repo.
 * @param {string} root @param {string} agent  autopilot's agent; unknown agents (a custom command) get the repo's MCP files
 * @returns {Set<string>} normalised names
 */
export function configuredServers(root, agent) {
  const home = homedir();
  const src = MCP_SOURCES[agent] ?? { repo: MCP_FILES, home: [] };
  const names = new Set();
  for (const f of [...src.repo.map((r) => join(root, r)), ...src.home.map((h) => join(home, h))]) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    if (f.endsWith('.toml')) {
      for (const m of text.matchAll(/^\[mcp_servers\.([\w-]+)\]/gm)) names.add(norm(m[1]));
      continue;
    }
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      continue; // JSONC or hand-edited: the CLI reports its own parse errors
    }
    // ~/.claude.json keeps per-project servers under projects[<path>]: only this repo's count
    const mine = Object.entries(o.projects ?? {}).filter(([path]) => slash(path) === slash(root)).map(([, p]) => /** @type {any} */ (p)?.mcpServers);
    for (const group of [o.mcpServers, o.servers, o.mcp, o['amp.mcpServers'], ...mine]) for (const n of Object.keys(group ?? {})) names.add(norm(n));
  }
  return names;
}

/**
 * The MCP servers one step needs: those it lists, those it names with "MCP", and the goal's servers it mentions by name
 * ("Art pass: PixelLab vertical slice" when the brief says the pixellab MCP server is there for art).
 * @param {{ title: string, body?: string, tools?: string[] }} step @param {string[]} goalServers
 */
export function stepTools(step, goalServers) {
  const text = `${step.title}\n${step.body ?? ''}`;
  const named = goalServers.filter((g) => norm(text).includes(norm(g)));
  return [...new Set([...(step.tools ?? []).map((t) => t.toLowerCase()), ...mcpMentions(text), ...named])];
}

/** @param {string[]} servers @param {string} root @param {string} agent */
export const missingServers = (servers, root, agent) => {
  const have = configuredServers(root, agent);
  return servers.filter((s) => !have.has(norm(s)));
};

/**
 * Can this goal start? Its MCP servers (named in it or in the docs it points at) must be there for the agent.
 * @param {string} root @param {string} goal @param {string} agent
 * @returns {string | undefined} why not, and what to do
 */
export function goalBlocker(root, goal, agent) {
  const absent = missingServers(mcpMentions(goalText(root, goal)), root, agent);
  if (!absent.length) return undefined;
  const them = absent.length > 1 ? 'them' : 'it';
  const where = MCP_SOURCES[agent] ? [...MCP_SOURCES[agent].repo, ...MCP_SOURCES[agent].home.map((h) => `~/${h}`)].join(' or ') : MCP_FILES.join(' or ');
  return `not started: the goal needs the ${absent.join(', ')} MCP server${absent.length > 1 ? 's' : ''}, but ${agent} does not have ${them} for this project. Add ${them} to ${where}, then start the goal again. (A server set up for another CLI or another project does not count.)`;
}

/**
 * Servers no agent of this step called, judged from the transcripts of its runs.
 * @param {string} root @param {string[]} servers @param {{ task?: string, since: number }} scope
 */
export function unusedServers(root, servers, scope) {
  const runs = readRuns(root).map((r) => /** @type {any} */ (r)).filter((r) => (scope.task ? r.task === scope.task : true) && Date.parse(String(r.ts)) >= scope.since - 1000);
  const called = runs.flatMap((r) => readRun(root, String(r.transcript ?? r.id)).filter((e) => e.kind === 'call').map((e) => norm(e.tool ?? '')));
  return servers.filter((s) => !called.some((t) => t.includes(norm(s))));
}
