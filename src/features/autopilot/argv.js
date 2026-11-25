import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../../adapters/index.js';
import { loadConfig } from '../../core/config.js';

/** @param {string} root @returns {Record<string, string> | undefined} */
function currentModels(root) {
  try {
    return loadConfig(root).autopilot.models ?? {};
  } catch {
    return undefined; // an invalid file mid-edit: keep the run's config
  }
}

const PEERS = fileURLToPath(new URL('./peers/peers.cjs', import.meta.url));
const PEERS_OMP = fileURLToPath(new URL('./peers/peers-omp.js', import.meta.url));

/**
 * A parallel worker (WOLOLO_WORKER set) loads the peer hook for this run only: claims checked before
 * edits, messages from the other agents after every tool call. Harnesses without per-run hooks get
 * the other agents' notes in their prompt only.
 * @param {string} agent
 * @returns {string[]}
 */
export function peerArgs(agent) {
  if (!process.env.WOLOLO_WORKER) return [];
  if (agent === 'omp') return [`--hook=${PEERS_OMP}`];
  if (agent === 'claude') {
    const cmd = (/** @type {string} */ mode) => [{ type: 'command', command: `node ${JSON.stringify(PEERS)} ${mode}` }];
    return ['--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: cmd('pre') }], PostToolUse: [{ matcher: '*', hooks: cmd('post') }] } })];
  }
  return [];
}

/**
 * The argv that runs one headless agent turn with this prompt.
 * @param {import('../../core/config.js').Config} config
 * @param {string} agent
 * @param {string} prompt
 * @param {{ tools?: boolean, root?: string }} [opts]  tools: false for a run that only answers;
 *   root: read the model from wololo.config.json now (the TUI can change it while autopilot runs)
 */
export function agentArgv(config, agent, prompt, opts = {}) {
  if (config.autopilot.command?.length) return config.autopilot.command.map((a) => a.replaceAll('{prompt}', prompt));
  const adapter = ADAPTERS[agent];
  if (!adapter?.headless) throw new Error(`agent "${agent}" has no headless mode; set autopilot.command in wololo.config.json`);
  // the file as it is now wins, including a model cleared back to the default
  const model = ((opts.root && currentModels(opts.root)) || config.autopilot.models || {})[agent];
  return [...adapter.headless(prompt, { contextWindow: config.autopilot.contextWindow, thinking: config.autopilot.thinking, ...opts }), ...(model && adapter.model ? adapter.model(model) : []), ...(adapter.stream ?? []), ...peerArgs(agent)];
}
