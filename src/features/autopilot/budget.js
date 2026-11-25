// Small context windows: everything autopilot hands an agent is sized against the window, not the other way round.

const CHARS_PER_TOKEN = 4;
const DEFAULT_FAILURE_CHARS = 12_000;

/**
 * Characters of gate output a fixer receives: 10% of the window, so the agent keeps room to read code and work.
 * @param {number | undefined} contextWindow tokens
 */
export function failureBudget(contextWindow) {
  return contextWindow ? Math.round(contextWindow * CHARS_PER_TOKEN * 0.1) : DEFAULT_FAILURE_CHARS;
}

/**
 * Keep the last `max` characters: failures are at the end of the output.
 * @param {string} text
 * @param {number} max
 */
export function clip(text, max) {
  if (text.length <= max) return text;
  const marker = '… (earlier output omitted)\n';
  return marker + text.slice(-(max - marker.length));
}

/** @param {number | undefined} contextWindow */
export function windowLabel(contextWindow) {
  return contextWindow ? `${Math.round(contextWindow / 1000)}k-token context window` : '';
}

/**
 * Explain a context overflow in an agent's output, or '' if there was none.
 * @param {string} output
 * @param {{ contextWindow?: number, command?: string[] }} autopilot
 */
export function overflowHint(output, autopilot) {
  if (!/context (size|length|window)|n_ctx|too many tokens|maximum context/i.test(output)) return '';
  const nums = /(\d+) tokens\)? exceeds[^\d]*(\d+) tokens/i.exec(output) ?? /n_prompt_tokens"?:\s*(\d+)[\s\S]*?n_ctx"?:\s*(\d+)/.exec(output);
  const [sent, ctx] = nums ? [Number(nums[1]), Number(nums[2])] : [];
  const lines = [nums ? `Context overflow: the agent sent ${sent} tokens, the model has ${ctx}.` : 'Context overflow: the agent\'s prompt is larger than the model\'s context window.'];
  const window = autopilot.contextWindow;
  if (!window) lines.push(`Set autopilot.contextWindow in wololo.config.json${ctx ? ` to ${ctx}` : ''} so wololo trims what the agent loads.`);
  else if (ctx && window > ctx) lines.push(`autopilot.contextWindow is ${window} but the model has ${ctx}: set it to ${ctx}.`);
  if (autopilot.command?.length) lines.push('autopilot.command is set, which bypasses the agent adapter\'s small-window trimming (tools, skills): remove it to use autopilot.agent.');
  else if (window && !ctx)
    lines.push(
      'The context most likely grew during the run (file reads, command output, web pages) past what the agent compacts in time. wololo pins compaction to autopilot.contextWindow for omp; for other agents set their auto-compact threshold, or give the model a bigger context. If it fails on the first request, trim your user-level agent config (global skills, plugins, MCP servers).',
    );
  else if (window && ctx && window <= ctx) lines.push('wololo already trims what it controls; the rest is the agent\'s own system prompt and your user-level agent config (global skills, plugins, MCP servers). Trim those or give the model a bigger context.');
  return lines.join('\n');
}

/**
 * Lines of code an agent should write in one reply: about 10% of the window at ~20 tokens a line,
 * rounded down to 50. Longer replies hit the output limit and are cut off (omp compacts as "incomplete").
 * @param {number} contextWindow
 */
export const editLines = (contextWindow) => Math.max(50, Math.floor(contextWindow / 200 / 50) * 50);

/**
 * How big one plan step may be, so a fresh agent can finish it inside the window.
 * @param {number | undefined} contextWindow
 */
export const stepSize = (contextWindow) => (contextWindow ? `at most 3 files and about ${editLines(contextWindow) * 2} lines of new code; split bigger features (types first, then one system at a time, then wiring)` : 'a few files, one behaviour');

/**
 * Working rules for agents on a small window. Empty when no window is configured.
 * @param {number | undefined} contextWindow
 */
export function contextRules(contextWindow) {
  if (!contextWindow) return [];
  return [
    `You have a ${windowLabel(contextWindow)}; spend it carefully:`,
    '- Search before reading; open only the files and line ranges you need.',
    '- Never print large outputs: pipe commands through `tail`/`head`, run single tests.',
    `- Write at most ${editLines(contextWindow)} lines per edit or new file: longer replies get cut off. Create a big file as a skeleton, then fill it in.`,
    '- Commit as soon as a piece builds, so a fresh agent can continue from there if you run out of context.',
    '- Record progress early with `task note` so a fresh agent can continue if you run out of context.',
  ];
}
