import { agentFiles, mcpServer, ownedBy, upsert } from './types.js';

const ours = ownedBy('cursor');

/** @type {import('./types.js').Adapter} */
export default {
  id: 'cursor',
  label: 'Cursor',
  binary: 'cursor-agent',
  skillDirs: ['.cursor/skills', '.claude/skills'],
  model: (m) => ['--model', m],
  headless: (prompt) => ['cursor-agent', '-p', prompt, '--force'],
  ops: (ctx) => [
    { kind: 'json', path: '.cursor/mcp.json', merge: (o) => ({ ...o, mcpServers: { ...o.mcpServers, wololo: mcpServer(ctx) } }) },
    {
      kind: 'json',
      path: '.cursor/hooks.json',
      merge: (o) => ({
        version: 1,
        ...o,
        hooks: {
          ...o.hooks,
          afterFileEdit: upsert(o.hooks?.afterFileEdit, ours, { command: ctx.hook('cursor', 'post-edit') }),
          stop: upsert(o.hooks?.stop, ours, { command: ctx.hook('cursor', 'stop') }),
        },
      }),
    },
    ...agentFiles('.cursor/agents', ctx.agents, (a) => ({ name: a.name, description: a.description })),
  ],
};
