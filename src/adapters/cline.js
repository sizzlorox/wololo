/** @type {import('./types.js').Adapter} */
export default {
  id: 'cline',
  label: 'Cline',
  skillDirs: [],
  ops: (ctx) => [
    { kind: 'write', path: '.clinerules/wololo.md', content: '# wololo\n\nFollow AGENTS.md at the repository root. Workflows live in .clinerules/workflows.\n' },
    ...ctx.skills.map((s) => {
      const main = s.files.find((f) => f.rel === 'SKILL.md');
      const body = (main?.content ?? '').replace(/^---[\s\S]*?---\s*/, '');
      return /** @type {const} */ ({ kind: 'write', path: `.clinerules/workflows/${s.name}.md`, content: `<!-- ${s.description} -->\n${body}` });
    }),
  ],
  notes: ['Cline MCP servers are global: add the wololo server in Cline > MCP Servers.'],
};
