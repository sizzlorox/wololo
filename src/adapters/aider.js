/** @type {import('./types.js').Adapter} */
export default {
  id: 'aider',
  label: 'Aider',
  binary: 'aider',
  skillDirs: [],
  model: (m) => ['--model', m],
  headless: (prompt) => ['aider', '--yes-always', '--message', prompt],
  ops: (ctx) => [
    {
      kind: 'block',
      path: '.aider.conf.yml',
      style: 'hash',
      content: ['read:', '  - AGENTS.md', `lint-cmd: ${ctx.config.bin} check`, `test-cmd: ${ctx.config.bin} verify --fast`].join('\n'),
    },
  ],
  notes: ['Aider has no skills or MCP: AGENTS.md lists skill paths, and wololo check/verify run as its lint/test commands.'],
};
