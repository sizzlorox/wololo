import { spawn, spawnSync } from './proc.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';

/**
 * @typedef {object} ExecResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} ms
 * @property {boolean} timedOut
 */

/**
 * Run a shell command, capturing output. Never inherits stdio, so it is safe inside the MCP server.
 * @param {string} command
 * @param {{ cwd: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, input?: string }} opts
 * @returns {Promise<ExecResult>}
 */
export function sh(command, opts) {
  return spawnCapture(command, [], { ...opts, shell: true });
}

/**
 * Run argv without a shell (used for agent CLIs, where prompts must not be shell-interpreted).
 * @param {string[]} argv
 * @param {{ cwd: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, input?: string, onData?: (chunk: string) => void, signal?: AbortSignal }} opts
 * @returns {Promise<ExecResult>}
 */
export function run(argv, opts) {
  const resolved = process.platform === 'win32' ? resolveWindows(argv[0]) : [argv[0]];
  if (!resolved) {
    const stderr = `cannot run ${argv[0]} without a shell on Windows; set autopilot.command in wololo.config.json to the agent's .exe or [interpreter, script]`;
    return Promise.resolve({ code: 1, stdout: '', stderr, ms: 0, timedOut: false });
  }
  return spawnCapture(resolved[0], [...resolved.slice(1), ...argv.slice(1)], { ...opts, shell: false });
}

/**
 * Windows can't spawn npm/bun `.cmd` shims without a shell, and a shell would mangle prompts.
 * Resolve the shim to the interpreter + script it would run.
 * @param {string} file
 * @returns {string[] | null}
 */
function resolveWindows(file) {
  const ext = extname(file).toLowerCase();
  if (ext && !['.cmd', '.bat'].includes(ext)) return [file];
  // `where npm` lists the extensionless sh script npm installs beside npm.cmd first; Windows cannot spawn it.
  const found = ext ? file : spawnSync('where', [file], { encoding: 'utf8' }).stdout?.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(exe|com|cmd|bat)$/i.test(l));
  if (!found) return [file];
  if (!/\.(cmd|bat)$/i.test(found)) return [found];
  return fromCmdShim(readFileSync(found, 'utf8'), found);
}

/**
 * Parse an npm cmd-shim into the argv prefix it runs, or null for shims we don't recognise.
 * @param {string} text
 * @param {string} shimPath
 * @param {(p: string) => boolean} [exists]
 * @returns {string[] | null}
 */
export function fromCmdShim(text, shimPath, exists = existsSync) {
  const dir = dirname(shimPath.replaceAll('\\', '/')).replaceAll('/', '\\');
  /** @param {string} p */
  const expand = (p) => p.replace(/%~?dp0%?\\?/i, `${dir}\\`);
  const call = text.split(/\r?\n/).reverse().find((l) => l.includes('%*'));
  if (!call) return null;
  const quoted = [...call.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const target = quoted.filter((q) => /%~?dp0/i.test(q)).pop();
  if (!target) return null;
  if (!quoted.some((q) => q === '%_prog%')) return /\.exe$/i.test(target) ? [expand(target)] : null;
  const progs = [...text.matchAll(/SET\s+"_prog=([^"]+)"/gi)].map((m) => m[1]);
  const local = progs.find((p) => /%~?dp0/i.test(p));
  const fallback = progs.find((p) => !/%~?dp0/i.test(p));
  const prog = local && exists(expand(local)) ? expand(local) : fallback;
  return prog ? [prog, expand(target)] : null;
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, input?: string, shell: boolean, onData?: (chunk: string) => void, signal?: AbortSignal }} opts
 * @returns {Promise<ExecResult>}
 */
function spawnCapture(file, args, opts) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;
    // An abort (e.g. a stalled agent) kills the whole tree, like a timeout.
    opts.signal?.addEventListener('abort', () => killTree(child.pid), { once: true });
    child.stdout.on('data', (d) => {
      stdout += d;
      opts.onData?.(String(d));
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      opts.onData?.(String(d));
    });
    child.on('error', (err) => {
      stderr += String(err.message);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, ms: Date.now() - started, timedOut });
    });
    child.stdin.end(opts.input ?? '');
  });
}

/**
 * Kill a process and everything it spawned (agents run compilers, dev servers, sub-agents).
 * @param {number | undefined} pid
 */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout ?? '';
  /** @type {Map<number, number[]>} */
  const kids = new Map();
  for (const line of ps.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p && pp) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) ?? []));
  for (const p of all) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * @param {string} bin
 */
export function onPath(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [bin], { stdio: 'ignore' }).status === 0;
}

/**
 * Split a command string into argv (handles simple quotes). Used for the configured `bin`.
 * @param {string} command
 */
export function splitCommand(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
