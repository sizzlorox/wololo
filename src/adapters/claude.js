import { agentFiles, mcpServer, ownedBy, upsert } from './types.js';

const ours = ownedBy('claude');

/** @type {import('./types.js').Adapter} */
export default {
  id: 'claude',
  label: 'Claude Code',
  binary: 'claude',
  skillDirs: ['.claude/skills'],
  stream: ['--output-format', 'stream-json', '--verbose'],
  model: (m) => ['--model', m],
  // Headless runs have nobody to approve a prompt: acceptEdits only pre-approves edits, so every
  // bash command (git, tests, builds) was refused. Full access, like the other agents' headless modes.
  headless: (prompt) => ['claude', '-p', prompt, '--permission-mode', 'bypassPermissions'],
  ops: (ctx) => [
    { kind: 'block', path: 'CLAUDE.md', style: 'md', content: '@AGENTS.md' },
    { kind: 'json', path: '.mcp.json', merge: (o) => ({ ...o, mcpServers: { ...o.mcpServers, wololo: mcpServer(ctx) } }) },
    {
      kind: 'json',
      path: '.claude/settings.json',
      merge: (o) => {
        const h = { ...o.hooks };
        /** @param {string} event */
        const cmd = (event) => ({ type: 'command', command: ctx.hook('claude', event) });
        h.PostToolUse = upsert(h.PostToolUse, ours, { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [cmd('post-edit')] });
        h.Stop = upsert(h.Stop, ours, { hooks: [cmd('stop')] });
        h.SessionStart = upsert(h.SessionStart, ours, { hooks: [cmd('session-start')] });
        return { ...o, hooks: h };
      },
    },
    ...agentFiles('.claude/agents', ctx.agents, (a) => ({ name: a.name, description: a.description })),
  ],
};
