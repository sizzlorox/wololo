import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESSES } from '../../core/config.js';
import { readJson, readText } from '../../core/files.js';

/**
 * @typedef {(question: string, fallback?: string) => Promise<string>} Ask
 *
 * @typedef {object} AppAnswers
 * @property {string} start
 * @property {string} ready
 * @property {string} drive
 * @property {string} look
 * @property {string[]} golden
 */

/**
 * Best guesses from files on disk, so most questions are answered by pressing enter.
 * @param {string} root
 */
export function appDefaults(root) {
  /** @param {string} f */
  const has = (f) => existsSync(join(root, f));
  const pkg = readJson(join(root, 'package.json'), /** @type {any} */ (null));
  const scripts = pkg?.scripts ?? {};
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
  const script = ['dev', 'start', 'serve'].find((s) => scripts[s]);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const web = ['next', 'vite', 'react-scripts', 'nuxt', '@sveltejs/kit', 'astro', '@remix-run/dev'].some((d) => deps[d]);
  const api = ['express', 'fastify', 'koa', 'hono', '@nestjs/core'].some((d) => deps[d]);
  const port = deps.next || deps['react-scripts'] ? 3000 : deps.vite || deps['@sveltejs/kit'] ? 5173 : deps.astro ? 4321 : 3000;
  const makeRun = ['run', 'dev', 'serve'].find((t) => new RegExp(`^${t}:`, 'm').test(readText(join(root, 'Makefile')) ?? ''));
  const start = script ? `${pm} run ${script}` : makeRun ? `make ${makeRun}` : pkg?.bin ? `node ${typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0]}` : '';
  const url = `http://localhost:${port}`;
  return {
    start,
    ready: web || api ? `${url} responds` : '',
    drive: web ? `Playwright MCP against ${url}: navigate, click through the flow, read the snapshot and console` : api ? `curl ${url}/… and check status codes and bodies` : pkg?.bin ? 'run the CLI with sample input and check output and exit code' : '',
    look: web ? 'browser console and network (Playwright MCP), server output in the terminal' : '',
  };
}

/**
 * @param {Ask} ask
 * @param {string} root
 * @returns {Promise<AppAnswers>}
 */
export async function interviewApp(ask, root) {
  const d = appDefaults(root);
  const start = await ask('How do you start the app locally?', d.start);
  const ready = start ? await ask('How do you know it is ready?', d.ready) : '';
  const drive = await ask('How should an agent drive it like a user (UI, API, CLI)?', d.drive);
  const look = await ask('Where do logs, errors and state show up?', d.look);
  /** @type {string[]} */
  const golden = [];
  for (let i = 1; i <= 8; i++) {
    const flow = await ask(`Golden path ${i}: a flow that must always work, and what proves it (blank to finish)`);
    if (!flow) break;
    golden.push(flow);
  }
  return { start, ready, drive, look, golden };
}

const TODO = {
  start: 'TODO(wololo): the one command that starts the app locally (and how to know it is ready).',
  drive: 'TODO(wololo): how to drive it like a user. e.g. Playwright MCP against http://localhost:3000, `curl` against the API, or the CLI with sample input.',
  look: 'TODO(wololo): where logs, screenshots, traces and DB state live, and how to read them.',
  golden: 'TODO(wololo): the 3–5 flows that must always work, each with the observable result that proves it.',
};

/**
 * Fill the verify-app template. Unanswered sections keep their TODO(wololo) so doctor and garden keep nagging.
 * @param {string} template
 * @param {AppAnswers} a
 */
export function renderVerifyApp(template, a) {
  const start = a.start ? `\`${a.start}\`${a.ready ? `\n\nReady when: ${a.ready}.` : ''}` : TODO.start;
  return template
    .replace(TODO.start, start)
    .replace(TODO.drive, a.drive || TODO.drive)
    .replace(TODO.look, a.look || TODO.look)
    .replace(TODO.golden, a.golden.length ? a.golden.map((g, i) => `${i + 1}. ${g}`).join('\n') : TODO.golden);
}

/**
 * @param {Ask} ask
 * @param {string[]} detected
 */
export async function interviewHarnesses(ask, detected) {
  const answer = await ask(`Which agents do you use? (${HARNESSES.join(', ')}, or "all")`, detected.length ? detected.join(',') : 'all');
  if (!answer || answer.trim() === 'all') return [...HARNESSES];
  const picked = answer.split(/[\s,]+/).filter((h) => /** @type {readonly string[]} */ (HARNESSES).includes(h));
  return picked.length ? picked : [...HARNESSES];
}

/**
 * Harnesses whose project files already exist: a good default for the question.
 * @param {string} root
 */
export function detectHarnesses(root) {
  /** @type {[string, string[]][]} */
  const marks = [
    ['claude', ['CLAUDE.md', '.claude']],
    ['codex', ['.codex']],
    ['copilot', ['.github/copilot-instructions.md', '.github/agents']],
    ['cursor', ['.cursor', '.cursorrules']],
    ['gemini', ['GEMINI.md', '.gemini']],
    ['windsurf', ['.windsurf', '.windsurfrules']],
    ['opencode', ['opencode.json', '.opencode']],
    ['amp', ['.amp']],
    ['aider', ['.aider.conf.yml']],
    ['cline', ['.clinerules']],
    ['omp', ['.omp']],
  ];
  return marks.filter(([, files]) => files.some((f) => existsSync(join(root, f)))).map(([h]) => h);
}
