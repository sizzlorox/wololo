/**
 * Turn one line of a headless agent's output into something a human can follow. Agents that stream
 * JSON events (omp `--mode json`, claude `--output-format stream-json`) are recognised by shape, so
 * a custom `autopilot.command` that wraps them works too. Plain text lines pass through.
 *
 * @typedef {object} Activity
 * @property {string} [say]     One line of activity: a tool call, a failure, a remark.
 * @property {string} [text]    The agent's answer so far (replaces raw JSON as the run's output).
 * @property {number} [tokens]  Context in use after the latest model turn.
 * @property {string} [tool]   Set for tool calls: the tool's name.
 * @property {'work' | 'compact' | 'error'} [kind]  Tool calls and answers are work; compactions and model errors are not.
 * @property {number} [cutoff]  The reply was cut off at the output cap after this many output tokens.
 * @property {string} [model]   The model the agent says it is running.
 * @property {import('./usage.js').TurnUsage} [usage]  Tokens this turn used (or, with `final`, the run's totals).
 */

const SPINNER = /^(working|thinking)\.*$/i;
const WIDTH = 140;

/** @param {string} s */
const oneLine = (s) => s.replace(/\s+/g, ' ').trim().slice(0, WIDTH);

/**
 * The part of a tool call's arguments a human needs: the command, file, pattern or URL.
 * @param {any} args
 */
function target(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'cmd', 'path', 'file_path', 'filePath', 'file', 'pattern', 'query', 'url', 'description', 'prompt']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key];
  }
  return JSON.stringify(args);
}

/** @param {string} tool @param {any} args @param {string} [intent] */
const call = (tool, args, intent) => oneLine(`${tool}: ${target(args)}${intent ? ` (${intent})` : ''}`);

/** @param {any} content */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
      : '';

/** @param {any} usage */
const contextTokens = (usage) => {
  if (!usage || typeof usage !== 'object') return undefined;
  const sum = ['input', 'cacheRead', 'cacheWrite', 'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((n, k) => n + (Number(usage[k]) || 0), 0);
  return sum || undefined;
};

/** omp usage: { input, output, cacheRead, cacheWrite, cost: { input, cacheRead, total } }. @param {any} u @returns {import('./usage.js').TurnUsage | undefined} */
const ompUsage = (u) =>
  u && typeof u === 'object'
    ? { input: Number(u.input) || 0, output: Number(u.output) || 0, cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0, cost: Number(u.cost?.total) || 0, inputCost: Number(u.cost?.input) || 0, cacheReadCost: Number(u.cost?.cacheRead) || 0 }
    : undefined;

/** claude usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }. @param {any} u @returns {import('./usage.js').TurnUsage | undefined} */
const claudeUsage = (u) =>
  u && typeof u === 'object'
    ? { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cacheRead: Number(u.cache_read_input_tokens) || 0, cacheWrite: Number(u.cache_creation_input_tokens) || 0 }
    : undefined;

/** @param {string} text @param {number | undefined} tokens @returns {Activity} */
function answer(text, tokens) {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean);
  return { ...(first ? { say: oneLine(`says: ${first}`), text } : {}), ...(tokens ? { tokens } : {}) };
}

/** omp (pi) `--mode json` events. @param {any} e @returns {Activity | undefined} */
function omp(e) {
  switch (e.type) {
    case 'tool_execution_start':
      return { say: call(e.toolName, e.args, e.intent), kind: 'work', tool: String(e.toolName) };
    case 'tool_execution_end':
      return e.isError ? { say: oneLine(`${e.toolName} failed: ${textOf(e.result?.content) || ''}`), kind: 'error' } : { kind: 'work' };
    case 'auto_compaction_start':
      return { say: `compacting context (${e.reason ?? 'threshold'})`, kind: 'compact' };
    case 'auto_compaction_end':
      return { say: 'context compacted', kind: 'compact' };
    case 'message_end': {
      const m = e.message;
      if (m?.role !== 'assistant') return {};
      if (m.stopReason === 'length') {
        const n = Number(m.usage?.output) || 0;
        const tokens = contextTokens(m.usage);
        return { say: `reply cut off at the output limit (${n} output tokens)`, kind: 'compact', cutoff: n, ...(tokens ? { tokens } : {}) };
      }
      if (m.stopReason === 'error' || m.errorMessage) return { say: oneLine(`error: ${m.errorMessage ?? 'model error'}`), text: m.errorMessage ?? '', kind: 'error' };
      return { ...answer(textOf(m.content), contextTokens(m.usage)), kind: 'work' };
    }
    default:
      return undefined;
  }
}

/** claude `--output-format stream-json --verbose` events. @param {any} e @returns {Activity | undefined} */
function claude(e) {
  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    const tools = e.message.content.filter((/** @type {any} */ c) => c.type === 'tool_use');
    const tokens = contextTokens(e.message.usage);
    if (tools.length) return { say: tools.map((/** @type {any} */ t) => call(t.name, t.input)).join('; '), ...(tokens ? { tokens } : {}), kind: 'work', tool: tools.map((/** @type {any} */ t) => t.name).join(',') };
    return { ...answer(textOf(e.message.content), tokens), kind: 'work' };
  }
  if (e.type === 'user' && Array.isArray(e.message?.content)) {
    const failed = e.message.content.find((/** @type {any} */ c) => c.type === 'tool_result' && c.is_error);
    return failed ? { say: oneLine(`tool failed: ${textOf(failed.content)}`) } : {};
  }
  if (e.type === 'result') return { text: typeof e.result === 'string' ? e.result : '', ...(e.is_error ? { say: oneLine(`error: ${e.result ?? e.subtype}`) } : {}) };
  return typeof e.type === 'string' ? {} : undefined;
}

/**
 * @param {string} line
 * @returns {Activity}
 */
export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || SPINNER.test(trimmed)) return {};
  if (trimmed.startsWith('{')) {
    try {
      const e = JSON.parse(trimmed);
      const a = omp(e) ?? claude(e) ?? {};
      // omp and claude name the model on assistant messages; claude also in its `system` init event.
      const model = e.message?.model ?? (e.type === 'system' ? e.model : undefined);
      const usage =
        e.type === 'message_end' && e.message?.role === 'assistant'
          ? ompUsage(e.message.usage)
          : e.type === 'assistant' && e.message?.usage
            ? { .../** @type {import('./usage.js').TurnUsage} */ (claudeUsage(e.message.usage)), ...(e.message.id ? { id: String(e.message.id) } : {}) }
            : e.type === 'result' && e.usage
              ? { .../** @type {import('./usage.js').TurnUsage} */ (claudeUsage(e.usage)), cost: Number(e.total_cost_usd) || 0, final: true }
              : undefined;
      return { ...a, ...(typeof model === 'string' && model ? { model } : {}), ...(usage ? { usage } : {}) };
    } catch {
      // not JSON after all: fall through to plain text
    }
  }
  return { say: oneLine(trimmed) };
}
