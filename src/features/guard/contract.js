import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { git, gitOut } from '../../core/git.js';
import { listRepos, parseBase, repoDir } from '../../core/repos.js';
import { CONFIG_FILE, WOLOLO_DIR } from '../../core/state.js';
import { allSteps } from '../verify/command.js';

/**
 * The verification contract: everything the gate's verdict rests on. Verification may grow as the
 * project grows (new steps, new checks, new tests), but anything that would let the same code pass
 * more easily (a step removed or rewritten, a gate script or test-runner config edited, a test
 * deleted or left with fewer assertions, the rubric changed) is a weakening, and only a human
 * accepts it. Agents take shortcuts; this is the shortcut they cannot take.
 *
 * @typedef {object} Contract
 * @property {Record<string, string>} steps   verify step name → what it runs
 * @property {Record<string, string>} files   gate files (scripts a step runs, test-runner configs, the rubric) → content hash
 * @property {Record<string, string>} scripts package.json scripts a step runs, directly or through other scripts → their command
 * @property {Record<string, number>} tests   test file → assertions in it
 * @property {number} minScore
 */

/** Test-runner and compiler configs: one line in them (an exclude, a lowered strictness) silently skips checks. */
const RUNNER_CONFIGS = /^(vitest|vite|jest|playwright|cypress|karma|ava|mocha|babel)\.config\.[cm]?[jt]s$|^(tsconfig[\w.-]*\.json|pytest\.ini|tox\.ini|setup\.cfg|\.mocharc\.[\w]+|\.c8rc(\.json)?|\.nycrc(\.json)?)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
/** Calls that assert something, across the common runners. ponytail: a count, not a parse; an agent could swap one assertion for a weaker one and keep the count. */
const ASSERTION = /\b(expect|assert(?:\.\w+)?|assert_eq!?|assert_ne!?|assert!|t\.(?:is|deepEqual|true|false|throws)|should)\s*\(|^[ \t]*assert[ \t]+[^\s=(]/gm;

const hash = (/** @type {string} */ s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** @param {string} file */
const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** @param {string} text */
export const assertions = (text) => (text.match(ASSERTION) ?? []).length;

/**
 * package.json scripts a command runs, followed through scripts that run other scripts.
 * @param {string} command @param {Record<string, string>} scripts
 */
export function scriptsRun(command, scripts) {
  /** @type {Record<string, string>} */
  const found = {};
  const visit = (/** @type {string} */ cmd) => {
    const names = [...cmd.matchAll(/\b(?:npm|pnpm|yarn|bun)(?:\s+run(?:-script)?)?\s+([\w:.-]+)/g)].map((m) => m[1]);
    for (const name of names) {
      const n = name === 't' ? 'test' : name;
      if (scripts[n] === undefined || found[n] !== undefined) continue;
      found[n] = scripts[n];
      visit(scripts[n]);
    }
  };
  visit(command);
  return found;
}

/**
 * How to read one repo: from disk, or from a commit (fixed history the agent's working tree cannot change).
 * @param {string} dir @param {string | undefined} sha
 * @returns {{ read: (rel: string) => string | undefined, list: () => string[] }}
 */
function source(dir, sha) {
  if (!sha) return { read: (rel) => read(join(dir, rel)), list: () => gitOut(dir, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean) };
  return {
    read: (rel) => {
      const r = git(dir, ['show', `${sha}:${rel.replace(/\\/g, '/')}`]);
      return r.status === 0 ? r.stdout : undefined;
    },
    list: () => gitOut(dir, ['ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean),
  };
}

/**
 * The contract as the working tree has it now, or with `base` (a heads() value) as it was at those commits.
 * @param {import('../../core/types.js').Ctx} ctx @param {string} [base]
 * @returns {Contract}
 */
export function contractOf(ctx, base) {
  const { root } = ctx;
  const shas = parseBase(base ?? '');
  const repos = listRepos(root).length ? listRepos(root) : ['.'];
  const sources = new Map(repos.map((r) => [repoDir(root, r), source(repoDir(root, r), shas[r])]));
  const rootSource = sources.get(root) ?? source(root, undefined);
  /** the config at the base, so a step removed in the working tree still counts */
  const raw = base ? JSON.parse(rootSource.read(CONFIG_FILE) ?? 'null') : null;
  const config = raw ? { ...ctx.config, verify: { ...ctx.config.verify, ...raw.verify }, gate: { ...ctx.config.gate, ...raw.gate } } : ctx.config;
  /** @type {Contract} */
  const c = { steps: {}, files: {}, scripts: {}, tests: {}, minScore: config.gate.minScore };
  const key = (/** @type {string} */ abs) => relative(root, abs).replace(/\\/g, '/');
  const addFile = (/** @type {string} */ dir, /** @type {string} */ rel) => {
    const text = (sources.get(dir) ?? source(dir, undefined)).read(rel);
    if (text !== undefined) c.files[key(join(dir, rel))] = hash(text);
  };
  for (const s of allSteps({ ...ctx, config })) {
    c.steps[s.name] = s.app ? JSON.stringify(s.app) : (s.run ?? '');
    const src = sources.get(s.cwd) ?? source(s.cwd, undefined);
    const scripts = JSON.parse(src.read('package.json') ?? '{}').scripts ?? {};
    const run = s.run ?? '';
    const used = scriptsRun(run, scripts);
    for (const [name, cmd] of Object.entries(used)) c.scripts[`${key(join(s.cwd, 'package.json'))}#${name}`] = cmd;
    // files a command names (a verify script, a config passed with -c): editing one changes what the step checks
    for (const cmd of [run, ...Object.values(used)])
      for (const t of cmd.split(/[\s"'=]+/)) if (/[\w-]\.[a-z]{1,5}$/i.test(t) && !/^https?:/.test(t)) addFile(s.cwd, t);
  }
  addFile(root, `${WOLOLO_DIR}/rubric.json`);
  for (const [dir, src] of sources) {
    for (const f of src.list()) {
      if (f.includes('node_modules/') || f.startsWith(`${WOLOLO_DIR}/`)) continue;
      const name = f.split('/').pop() ?? '';
      if (RUNNER_CONFIGS.test(name)) addFile(dir, f);
      else if (TEST_FILE.test(f)) {
        const text = src.read(f);
        if (text !== undefined) c.tests[key(join(dir, f))] = assertions(text);
      }
    }
  }
  return c;
}

/**
 * What changed between the locked contract and now: additions are the project growing, weakenings need a human.
 * @param {Contract} locked @param {Contract} now
 * @returns {{ weakened: string[], added: string[] }}
 */
export function compare(locked, now) {
  /** @type {string[]} */
  const weakened = [];
  /** @type {string[]} */
  const added = [];
  for (const [name, run] of Object.entries(locked.steps)) {
    if (!(name in now.steps)) weakened.push(`verify step "${name}" was removed (it ran: ${run})`);
    else if (now.steps[name] !== run) weakened.push(`verify step "${name}" was changed: ${run} → ${now.steps[name]}`);
  }
  for (const name of Object.keys(now.steps)) if (!(name in locked.steps)) added.push(`verify step "${name}"`);
  for (const [s, cmd] of Object.entries(locked.scripts)) {
    if (!(s in now.scripts)) weakened.push(`script ${s} is no longer run by the gate (it ran: ${cmd})`);
    else if (now.scripts[s] !== cmd) weakened.push(`script ${s} the gate runs was changed: ${cmd} → ${now.scripts[s]}`);
  }
  for (const [f, h] of Object.entries(locked.files)) {
    if (!(f in now.files)) weakened.push(`${f}, part of the gate, was deleted`);
    else if (now.files[f] !== h) weakened.push(`${f}, part of the gate, was edited`);
  }
  for (const f of Object.keys(now.files)) if (!(f in locked.files)) added.push(f);
  for (const [f, n] of Object.entries(locked.tests)) {
    if (!(f in now.tests)) weakened.push(`test file ${f} was deleted (${n} assertion(s))`);
    else if (now.tests[f] < n) weakened.push(`test file ${f} lost assertions: ${n} → ${now.tests[f]}`);
  }
  for (const f of Object.keys(now.tests)) if (!(f in locked.tests)) added.push(f);
  if (now.minScore < locked.minScore) weakened.push(`gate.minScore was lowered: ${locked.minScore} → ${now.minScore}`);
  return { weakened, added };
}
