import { mcpServer, ownedBy, upsert } from './types.js';

/** @param {unknown} v @returns {string[]} */
const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : ['GEMINI.md']);

/** @type {import('./types.js').Adapter} */
export default {
  id: 'gemini',
  label: 'Gemini CLI',
  binary: 'gemini',
  skillDirs: ['.gemini/skills'],
  model: (m) => ['--model', m],
  headless: (prompt) => ['gemini', '-p', prompt, '--yolo'],
  ops: (ctx) => [
    {
      kind: 'json',
      path: '.gemini/settings.json',
      merge: (o) => {
        const names = asList(o.context?.fileName);
        return {
          ...o,
          context: { ...o.context, fileName: names.includes('AGENTS.md') ? names : [...names, 'AGENTS.md'] },
          mcpServers: { ...o.mcpServers, wololo: mcpServer(ctx) },
          hooks: {
            ...o.hooks,
            AfterTool: upsert(o.hooks?.AfterTool, ownedBy('gemini'), {
              matcher: 'write_file|replace|edit',
              hooks: [{ name: 'wololo-check', type: 'command', command: ctx.hook('gemini', 'post-edit') }],
            }),
          },
        };
      },
    },
  ],
};
