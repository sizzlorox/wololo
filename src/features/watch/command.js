import { render } from './render.js';
import { view } from './view.js';

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'watch',
    summary: 'Live view of a running autopilot: plan progress, the current agent, its tool calls, context use, git and gate. In a terminal it opens the TUI on its Autopilot tab.',
    mcp: false,
    options: {
      once: { type: 'boolean', description: 'Print one plain snapshot and exit (also the behaviour when stdout is not a terminal)' },
      interval: { type: 'number', description: 'Seconds between refreshes', default: 1 },
    },
    async run(input, ctx) {
      if (input.once || !process.stdout.isTTY) {
        const v = view(ctx.root, { width: 200, height: 60, color: false });
        return { ok: true, summary: render(v), data: v };
      }
      const { openTui } = await import('../tui/command.js');
      await openTui(ctx, { tab: 'autopilot', interval: input.interval });
      return { ok: true, summary: '', stdout: '' };
    },
  },
];
