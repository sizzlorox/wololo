import { createInterface } from 'node:readline/promises';
import { kebab, parseArgs } from './core/args.js';
import { findRoot, loadConfig, mcpTools } from './core/config.js';
import { serve } from './mcp/server.js';
import { COMMANDS, GROUPS } from './registry.js';
import { VERSION } from './core/version.js';


/**
 * @typedef {{ stdout: NodeJS.WritableStream & { isTTY?: boolean }, stderr: NodeJS.WritableStream, stdin: NodeJS.ReadableStream & { isTTY?: boolean }, cwd: string, env: NodeJS.ProcessEnv }} IO
 */

/**
 * `wololo mcp --tools a,b`: sync bakes the allowlist into the server args so harnesses that cache tool lists per spawn command see the change.
 * @param {string[]} rest
 */
function toolsFlag(rest) {
  const i = rest.indexOf('--tools');
  return i < 0 || rest[i + 1] === undefined ? undefined : rest[i + 1].split(',').map((t) => t.trim()).filter(Boolean);
}

/** @type {import('./core/types.js').Command} */
const mcpCommand = {
  name: 'mcp',
  summary: 'Serve every command as an MCP tool over stdio (wired into each harness by `wololo sync`).',
  options: { tools: { type: 'string', description: 'Comma-separated allowlist, e.g. gate,verify,check (default: mcp.tools, or a small set when autopilot.contextWindow < 64k)' } },
  mcp: false,
  async run() {
    throw new Error('handled by main');
  },
};

/**
 * @param {IO} io
 * @returns {import('./core/types.js').Ctx}
 */
export function makeCtx(io) {
  const { root, hasConfig } = findRoot(io.cwd);
  /** @type {string | undefined} */
  let stdinCache;
  const interactive = Boolean(io.stdin.isTTY && io.stdout.isTTY) && !io.env.CI;
  return {
    ...(interactive ? { prompt: (/** @type {string} */ q, /** @type {string | undefined} */ d) => ask(io, q, d), say: (/** @type {string} */ line) => void io.stderr.write(`${line}\n`) } : {}),
    cwd: io.cwd,
    root,
    hasConfig,
    config: loadConfig(root),
    env: io.env,
    async readStdin() {
      if (stdinCache !== undefined) return stdinCache;
      if (io.stdin.isTTY) return (stdinCache = '');
      const chunks = [];
      for await (const c of io.stdin) chunks.push(Buffer.from(c));
      return (stdinCache = Buffer.concat(chunks).toString('utf8'));
    },
  };
}

/**
 * Questions go to stderr so stdout stays machine-readable.
 * @param {IO} io @param {string} question @param {string} [fallback]
 */
async function ask(io, question, fallback) {
  const rl = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const answer = (await rl.question(`? ${question}${fallback ? ` [${fallback}]` : ''} `)).trim();
    return answer || fallback || '';
  } finally {
    rl.close();
  }
}

/** @param {import('./core/types.js').Command} c */
function usage(c) {
  const args = (c.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}${a.variadic ? '...' : ''}]`)).join(' ');
  const opts = Object.entries(c.options ?? {}).map(([k, o]) => `  --${kebab(k)}${o.type === 'boolean' ? '' : ` <${o.type}>`}  ${o.description}${o.default !== undefined ? ` (default: ${JSON.stringify(o.default)})` : ''}`);
  return [`wololo ${c.name}${args ? ` ${args}` : ''}`, '', c.summary, ...(opts.length ? ['', 'Options:', ...opts] : []), '  --json  Machine-readable output'].join('\n');
}

function help() {
  const lines = [`wololo ${VERSION} — a coding harness for every frontier agent`, '', 'Usage: wololo <command> [options]   (add --help to any command)', ''];
  const groups = { ...GROUPS, Setup: [...GROUPS.Setup, mcpCommand] };
  for (const [title, cmds] of Object.entries(groups)) {
    lines.push(`${title}:`);
    for (const c of cmds) lines.push(`  ${c.name.padEnd(20)} ${c.summary}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @param {IO} io
 * @returns {Promise<number>}
 */
export async function main(argv, io) {
  const json = argv.includes('--json');
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const rest = argv.filter((a) => a !== '--json' && a !== '--help' && a !== '-h');
  /** @param {string} s */
  const out = (s) => io.stdout.write(s.endsWith('\n') ? s : `${s}\n`);

  if (!rest.length && io.stdout.isTTY && io.stdin.isTTY && !io.env.CI) rest.push('tui');
  if (!rest.length || rest[0] === 'help') {
    out(help());
    return 0;
  }
  if (rest[0] === '--version' || rest[0] === 'version') {
    out(VERSION);
    return 0;
  }

  const all = [...COMMANDS, mcpCommand];
  const cmd = all
    .filter((c) => {
      const words = c.name.split(' ');
      return words.every((w, i) => rest[i] === w);
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!cmd) {
    const near = all.filter((c) => c.name.startsWith(rest[0])).map((c) => c.name);
    io.stderr.write(`unknown command "${rest.join(' ')}"${near.length ? `. Did you mean: ${near.join(', ')}?` : '. Run wololo help.'}\n`);
    return 2;
  }
  if (wantsHelp) {
    out(usage(cmd));
    return 0;
  }

  /** @type {import('./core/types.js').Ctx} */
  let ctx;
  try {
    ctx = makeCtx(io);
  } catch (e) {
    io.stderr.write(`${/** @type {Error} */ (e).message}\n`);
    return 1;
  }

  if (cmd === mcpCommand) {
    await serve({ commands: COMMANDS, makeCtx: () => makeCtx(io), input: io.stdin, output: io.stdout, version: VERSION, tools: toolsFlag(rest) ?? mcpTools(ctx.config) });
    return 0;
  }

  const { values, errors } = parseArgs(rest.slice(cmd.name.split(' ').length), cmd.options ?? {}, cmd.args ?? []);
  if (errors.length) {
    io.stderr.write(`${errors.join('\n')}\n\n${usage(cmd)}\n`);
    return 2;
  }

  let result;
  try {
    result = await cmd.run(values, ctx);
  } catch (e) {
    result = { ok: false, summary: `error: ${/** @type {Error} */ (e).message}` };
  }
  if (result.stdout !== undefined || result.stderr !== undefined) {
    if (result.stdout) out(result.stdout);
    if (result.stderr) io.stderr.write(`${result.stderr}\n`);
  } else if (json) out(JSON.stringify({ ok: result.ok, summary: result.summary, details: result.details ?? [], data: result.data ?? null }, null, 2));
  else out([result.summary, ...(result.details ?? []).map((d) => `  ${d}`)].join('\n'));
  return result.exitCode ?? (result.ok ? 0 : 1);
}
