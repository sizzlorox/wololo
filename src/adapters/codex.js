/** @type {import('./types.js').Adapter} */
export default {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  binary: 'codex',
  skillDirs: ['.agents/skills'],
  model: (m) => ['--model', m],
  headless: (prompt) => ['codex', 'exec', '--full-auto', prompt],
  ops: (ctx) => [
    {
      kind: 'block',
      path: '.codex/config.toml',
      style: 'hash',
      content: `[mcp_servers.wololo]\ncommand = ${JSON.stringify(ctx.mcp.command)}\nargs = ${JSON.stringify(ctx.mcp.args)}`,
    },
  ],
  notes: ['Codex reads AGENTS.md natively and loads project .codex/config.toml only for trusted projects.'],
};
