import { mcpServer } from './types.js';

/** @type {import('./types.js').Adapter} */
export default {
  id: 'amp',
  label: 'Amp',
  binary: 'amp',
  skillDirs: ['.agents/skills', '.claude/skills'],
  headless: (prompt) => ['amp', '-x', prompt],
  ops: (ctx) => [
    { kind: 'json', path: '.amp/settings.json', merge: (o) => ({ ...o, 'amp.mcpServers': { ...o['amp.mcpServers'], wololo: mcpServer(ctx) } }) },
  ],
};
