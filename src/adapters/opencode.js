import { agentFiles } from './types.js';

/** @type {import('./types.js').Adapter} */
export default {
  id: 'opencode',
  label: 'opencode',
  binary: 'opencode',
  skillDirs: ['.opencode/skills', '.claude/skills', '.agents/skills'],
  model: (m) => ['--model', m], // provider/model
  headless: (prompt) => ['opencode', 'run', prompt],
  ops: (ctx) => [
    {
      kind: 'json',
      path: 'opencode.json',
      merge: (o) => ({
        $schema: 'https://opencode.ai/config.json',
        ...o,
        mcp: { ...o.mcp, wololo: { type: 'local', command: [ctx.mcp.command, ...ctx.mcp.args], enabled: true } },
      }),
    },
    ...agentFiles('.opencode/agent', ctx.agents, (a) => ({ description: a.description, mode: 'subagent' })),
  ],
};
