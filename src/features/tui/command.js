import { runApp } from './app.js';
import { autopilot } from './screens/autopilot.js';
import { boardScreen } from './screens/board.js';
import { commandsScreen } from './screens/commands.js';
import { configScreen } from './screens/config.js';
import { health } from './screens/health.js';
import { learnedScreen } from './screens/learned.js';
import { queueScreen } from './screens/queue.js';
import { transcriptScreen } from './screens/transcript.js';
import { usage } from './screens/usage.js';

export const TABS = ['autopilot', 'transcript', 'board', 'queue', 'learned', 'health', 'usage', 'config', 'commands'];

/**
 * Open the TUI. The registry is imported here, not at the top, because it imports this file.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ tab?: string, interval?: number, io?: import('./app.js').Io, entry?: string }} [opts]
 */
export async function openTui(ctx, opts = {}) {
  const { COMMANDS } = await import('../../registry.js');
  await runApp(ctx, { screens: [autopilot, transcriptScreen, boardScreen, queueScreen, learnedScreen, health, usage, configScreen, commandsScreen(COMMANDS)], ...opts });
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'tui',
    summary: 'Run wololo from one screen: autopilot, board, queue, gate/verify/check, token usage, config and every other command. `wololo` alone opens it in a terminal.',
    mcp: false,
    options: {
      tab: { type: 'string', description: `Open on this tab: ${TABS.join(', ')}`, default: 'autopilot' },
    },
    async run(input, ctx) {
      if (!process.stdout.isTTY || !process.stdin.isTTY) return { ok: false, summary: 'the TUI needs an interactive terminal; use the commands directly (wololo help)', exitCode: 2 };
      await openTui(ctx, { tab: input.tab });
      return { ok: true, summary: '', stdout: '' };
    },
  },
];
