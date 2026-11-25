/**
 * @typedef {{ kind: 'write', path: string, content: string }
 *   | { kind: 'json', path: string, merge: (o: any) => any }
 *   | { kind: 'block', path: string, content: string, style: 'md' | 'hash' }} FileOp
 *
 * @typedef {{ name: string, description: string, files: { rel: string, content: string }[] }} Skill
 * @typedef {{ name: string, description: string, body: string }} AgentDef
 *
 * @typedef {object} SyncCtx
 * @property {string} root
 * @property {import('../core/config.js').Config} config
 * @property {Skill[]} skills
 * @property {AgentDef[]} agents
 * @property {{ command: string, args: string[] }} mcp
 * @property {(harness: string, event: string) => string} hook
 *
 * @typedef {object} Adapter
 * @property {string} id
 * @property {string} label
 * @property {string} [binary]         CLI binary, used by doctor and autopilot.
 * @property {string[]} skillDirs      Where the harness discovers SKILL.md folders. Preferred first.
 * @property {(ctx: SyncCtx) => FileOp[]} ops
 * @property {(model: string) => string[]} [model]  Flags that pick the model for a headless run (autopilot.models[harness]).
 * @property {(prompt: string, opts: HeadlessOpts) => string[]} [headless]  Argv for one headless turn; may trim itself for small context windows.
 * @property {string[]} [stream]       Flags that make headless output a JSON event stream, so autopilot can show what the agent is doing.
 * @property {string[]} [notes]        Manual, global-only steps the harness still needs.
 */

/**
 * @typedef {object} HeadlessOpts
 * @property {number} [contextWindow]
 * @property {boolean} [tools]     false: a run that only answers (the splitter); harnesses that can turn tools off do
 * @property {string} [thinking]   reasoning level (autopilot.thinking), for harnesses that take one
 */

import { stringifyFrontmatter } from '../core/frontmatter.js';

/**
 * Replace our entries (identified by `isOurs`) in a hook list, leaving the user's untouched.
 * @param {any[] | undefined} list
 * @param {(entry: any) => boolean} isOurs
 * @param {any} ours
 */
export function upsert(list, isOurs, ours) {
  return [...(list ?? []).filter((e) => !isOurs(e)), ours];
}

/**
 * @param {string} harness
 * @returns {(entry: any) => boolean}
 */
export const ownedBy = (harness) => (entry) => JSON.stringify(entry).includes(`hook ${harness} `);

/**
 * @param {string} dir
 * @param {import('./types.js').AgentDef[]} agents
 * @param {(a: import('./types.js').AgentDef) => Record<string, string>} front
 * @param {string} [suffix]
 * @returns {FileOp[]}
 */
export function agentFiles(dir, agents, front, suffix = '.md') {
  return agents.map((a) => ({ kind: 'write', path: `${dir}/${a.name}${suffix}`, content: stringifyFrontmatter(front(a), a.body) }));
}

/** @param {SyncCtx} ctx */
export const mcpServer = (ctx) => ({ command: ctx.mcp.command, args: ctx.mcp.args });
