import { createInterface } from 'node:readline';
import { coerce } from '../core/args.js';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** @param {import('../core/types.js').OptionSpec | { type: 'string' | 'string[]' }} spec */
function jsonType(spec) {
  if (spec.type === 'string[]') return { type: 'array', items: { type: 'string' } };
  return { type: spec.type };
}

/**
 * Commands become MCP tools with the same names, options and behaviour as the CLI. One way to do each thing.
 * @param {import('../core/types.js').Command} cmd
 */
export function toolFor(cmd) {
  /** @type {Record<string, any>} */
  const properties = {};
  const required = [];
  for (const p of cmd.args ?? []) {
    properties[p.name] = { ...(p.variadic ? { type: 'array', items: { type: 'string' } } : { type: 'string' }), description: p.description };
    if (p.required) required.push(p.name);
  }
  for (const [k, o] of Object.entries(cmd.options ?? {})) properties[k] = { ...jsonType(o), description: o.description, ...(o.default !== undefined ? { default: o.default } : {}) };
  return { name: `wololo_${cmd.name.replace(/ /g, '_')}`, description: cmd.summary, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } };
}

/**
 * @param {import('../core/types.js').Command} cmd
 * @param {Record<string, unknown>} args
 */
export function inputFor(cmd, args) {
  /** @type {Record<string, any>} */
  const input = {};
  for (const [k, o] of Object.entries(cmd.options ?? {})) {
    if (args[k] !== undefined) input[k] = coerce(o, args[k]);
    else if (o.default !== undefined) input[k] = o.default;
  }
  for (const p of cmd.args ?? []) {
    const v = args[p.name];
    if (v !== undefined) input[p.name] = p.variadic ? (Array.isArray(v) ? v.map(String) : [String(v)]) : String(v);
    else if (p.variadic) input[p.name] = [];
    else if (p.required) throw new Error(`missing argument ${p.name}`);
  }
  return input;
}

/**
 * Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited). No SDK, no dependencies.
 * @param {{ commands: import('../core/types.js').Command[], makeCtx: () => import('../core/types.js').Ctx, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, version: string, tools?: string[] }} opts
 */
export function serve(opts) {
  const allow = opts.tools?.length ? new Set(opts.tools) : undefined;
  const tools = opts.commands.filter((c) => c.mcp !== false && (!allow || allow.has(c.name) || allow.has(toolFor(c).name)));
  const byName = new Map(tools.map((c) => [toolFor(c).name, c]));
  /** @param {unknown} msg */
  const send = (msg) => opts.output.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: opts.input });

  /** @param {any} req */
  async function handle(req) {
    switch (req.method) {
      case 'initialize': {
        const asked = req.params?.protocolVersion;
        return {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'wololo', version: opts.version },
          instructions: 'wololo is the coding harness for this repo. Verify with wololo_verify, merge only when wololo_gate passes, buffer findings with wololo_queue_add, coordinate via wololo_task_*.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: tools.map(toolFor) };
      case 'tools/call': {
        const cmd = byName.get(req.params?.name);
        if (!cmd) throw Object.assign(new Error(`unknown tool ${req.params?.name}`), { code: -32602 });
        try {
          const r = await cmd.run(inputFor(cmd, req.params?.arguments ?? {}), opts.makeCtx());
          const text = [r.summary, ...(r.details ?? [])].join('\n');
          return { content: [{ type: 'text', text }], structuredContent: { ok: r.ok, summary: r.summary, data: r.data ?? null }, isError: !r.ok };
        } catch (e) {
          return { content: [{ type: 'text', text: `error: ${/** @type {Error} */ (e).message}` }], isError: true };
        }
      }
      default:
        throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
    }
  }

  rl.on('line', async (line) => {
    if (!line.trim()) return undefined;
    /** @type {any} */
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (req.id === undefined || req.id === null) return undefined; // notification
    try {
      send({ jsonrpc: '2.0', id: req.id, result: await handle(req) });
    } catch (e) {
      const err = /** @type {Error & { code?: number }} */ (e);
      send({ jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32603, message: err.message } });
    }
    return undefined;
  });
  return new Promise((resolve) => rl.on('close', () => resolve(undefined)));
}
