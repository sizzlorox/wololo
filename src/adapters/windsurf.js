/** @type {import('./types.js').Adapter} */
export default {
  id: 'windsurf',
  label: 'Windsurf (Cascade)',
  skillDirs: ['.windsurf/skills'],
  ops: () => [],
  notes: ['Windsurf reads AGENTS.md natively. MCP is global: add the wololo server to ~/.codeium/windsurf/mcp_config.json.'],
};
