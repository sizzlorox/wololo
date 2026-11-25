import { agentFiles, mcpServer } from './types.js';

/** @type {import('./types.js').Adapter} */
export default {
  id: 'copilot',
  label: 'GitHub Copilot (CLI, cloud agent, VS Code)',
  binary: 'copilot',
  skillDirs: ['.github/skills', '.claude/skills'],
  model: (m) => ['--model', m],
  headless: (prompt) => ['copilot', '-p', prompt, '--allow-all-tools'],
  ops: (ctx) => {
    /** @param {string} event */
    const hook = (event) => ({ type: 'command', bash: ctx.hook('copilot', event), powershell: ctx.hook('copilot', event), cwd: '.', timeoutSec: 120 });
    return [
      { kind: 'json', path: '.vscode/mcp.json', merge: (o) => ({ ...o, servers: { ...o.servers, wololo: { type: 'stdio', ...mcpServer(ctx) } } }) },
      { kind: 'json', path: '.mcp.json', merge: (o) => ({ ...o, mcpServers: { ...o.mcpServers, wololo: mcpServer(ctx) } }) },
      {
        kind: 'write',
        path: '.github/hooks/wololo.json',
        content: `${JSON.stringify({ version: 1, hooks: { sessionStart: [hook('session-start')], postToolUse: [hook('post-edit')] } }, null, 2)}\n`,
      },
      ...agentFiles('.github/agents', ctx.agents, (a) => ({ name: a.name, description: a.description }), '.agent.md'),
    ];
  },
  notes: ['Copilot cloud agent MCP servers are configured in repository settings; paste the wololo entry from .vscode/mcp.json there.'],
};
