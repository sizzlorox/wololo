import { readJson, writeJson } from '../../core/files.js';
import { git, gitOut } from '../../core/git.js';
import { listRepos, repoDir } from '../../core/repos.js';
import { statePath } from '../../core/state.js';

/**
 * Branch names for autopilot runs: the repo's own naming convention when its branches show one,
 * else Conventional Branch (feature/, bugfix/, perf/, …). Deterministic: no agent picks names.
 */

/** What a goal is, from its wording. First match wins; feature is the default. */
const KINDS = /** @type {const} */ ([
  ['bugfix', /\b(fix|fixes|fixing|bug|bugs|crash|crashes|broken|regression|error|errors)\b/i],
  ['perf', /\b(perf|performance|faster|speed( up)?|slow|optimi[sz]e|optimi[sz]ation|latency|memory usage)\b/i],
  ['refactor', /\b(refactor|refactoring|restructure|reorgani[sz]e|clean ?up|split .* into)\b/i],
  ['docs', /\b(docs?|documentation|readme|guide)\b/i],
  ['test', /^\s*(add|write|cover)\b.*\btests?\b/i],
]);

/** @param {string} goal @returns {'feature' | 'bugfix' | 'perf' | 'refactor' | 'docs' | 'test'} */
export function kindOf(goal) {
  for (const [kind, re] of KINDS) if (re.test(goal)) return kind;
  return 'feature';
}

/** Spellings of each kind seen in the wild, conventional first. */
const WORDS = {
  feature: ['feature', 'feat'],
  bugfix: ['bugfix', 'fix', 'bug'],
  perf: ['perf', 'performance'],
  refactor: ['refactor'],
  docs: ['docs', 'doc'],
  test: ['test', 'tests'],
};

/**
 * The naming style existing branches use: separator after the type, and which spelling of each type.
 * @param {string[]} names  local and remote branch names
 * @returns {{ sep: '/' | '-', words: Partial<Record<keyof typeof WORDS, string>> }}
 */
export function conventionOf(names) {
  const all = Object.values(WORDS).flat().concat('hotfix', 'release', 'chore');
  const re = new RegExp(`^(?:[^/]+/)?(${all.join('|')})([/-])\\S`, 'i');
  /** @type {Record<string, number>} */
  const seps = { '/': 0, '-': 0 };
  /** @type {Partial<Record<keyof typeof WORDS, string>>} */
  const words = {};
  for (const raw of names) {
    const name = raw.replace(/^(origin|upstream)\//, '');
    if (name.startsWith('wololo/')) continue;
    const m = re.exec(name);
    if (!m) continue;
    seps[m[2]]++;
    const word = m[1].toLowerCase();
    for (const [kind, spellings] of Object.entries(WORDS)) if (spellings.includes(word)) words[/** @type {keyof typeof WORDS} */ (kind)] ??= word;
  }
  return { sep: seps['-'] > seps['/'] ? '-' : '/', words };
}

/** First line, kebab-case, at most 48 characters, cut at a word boundary. A leading "fix" is dropped: the kind says it. @param {string} goal */
function slug(goal) {
  const s = goal.split('\n')[0].toLowerCase().replace(/^fix(es|ing)?\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (s.length <= 48) return s || 'autopilot';
  const cut = s.slice(0, 48);
  return cut.slice(0, cut.lastIndexOf('-') > 20 ? cut.lastIndexOf('-') : 48);
}

/**
 * @param {string} goal
 * @param {string[]} existing  local and remote branch names
 */
export function branchFor(goal, existing) {
  const kind = kindOf(goal);
  const { sep, words } = conventionOf(existing);
  const base = `${words[kind] ?? WORDS[kind][0]}${sep}${slug(goal)}`;
  const taken = new Set(existing.map((n) => n.replace(/^(origin|upstream)\//, '')));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

/** Branches autopilot never commits or merges onto, unless autopilot.protectedBranches says otherwise. */
export const PROTECTED = ['main', 'master', 'develop', 'dev', 'development', 'stage', 'staging', 'release', 'release/*', 'release-*', 'releases/*', 'prod', 'production', 'trunk', 'hotfix/*', 'qa', 'uat'];

/**
 * @param {string} branch
 * @param {string[]} [patterns]  exact names, or globs with *
 */
export function isProtected(branch, patterns = PROTECTED) {
  return patterns.some((p) => (p.includes('*') ? new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(branch) : p === branch));
}

/** The branch each plan works on, so resuming from main goes back to it. @param {string} root */
const plansFile = (root) => statePath(root, 'branches.json');

/** @param {string} root @param {string} key @param {string} branch */
export function rememberBranch(root, key, branch) {
  writeJson(plansFile(root), { ...readJson(plansFile(root), {}), [key]: branch });
}

/** Branches a repo may integrate on. A repo with more than one of them must say which features start from. */
export const INTEGRATION = ['main', 'master', 'develop', 'development', 'trunk'];

/**
 * The integration branches a repo has (local), in INTEGRATION order.
 * @param {string} dir
 */
export const integrationBranches = (dir) => INTEGRATION.filter((b) => git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).status === 0);

/**
 * Where a repo's feature branches start. Never guessed when it could be either: a repo that has
 * more than one integration branch (e.g. master and develop, used for different things) must set
 * it. Otherwise the branch it is on.
 * @param {string} dir @param {string} current @param {string} [configured]
 * @returns {{ base: string } | { ambiguous: string[] }}
 */
export function baseOf(dir, current, configured) {
  if (configured) return { base: configured };
  const candidates = integrationBranches(dir);
  if (candidates.length > 1) return { ambiguous: candidates };
  return { base: current && current !== 'HEAD' ? current : 'HEAD' };
}

/**
 * Put every repo on a branch autopilot may commit to. A repo on a protected branch (or a detached
 * HEAD) switches to the plan's remembered branch, or gets a new one named after the goal in the
 * repos' style, cut from that repo's base (develop, main, master: per repo). A repo already on an
 * unprotected branch stays there. Uncommitted changes come along; if git refuses, no run.
 * @param {string} root @param {string} goal
 * @param {{ key?: string, patterns?: string[], bases?: Record<string, string> }} [o]  key: the plan (group)
 * @returns {{ branch: string, created?: boolean, switched?: boolean, from?: string, notes: string[] } | { error: string }}
 */
export function ensureBranch(root, goal, o = {}) {
  const repos = listRepos(root);
  if (!repos.length) return { error: 'this folder is not a git repo and holds no repos' };
  const remembered = o.key ? /** @type {Record<string, string>} */ (readJson(plansFile(root), {}))[o.key] : undefined;
  const existing = repos.flatMap((r) => gitOut(repoDir(root, r), ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).split('\n').filter(Boolean));
  const name = remembered && !isProtected(remembered, o.patterns) ? remembered : branchFor(goal, existing);
  /** @type {string[]} */
  const notes = [];
  let created = false;
  let switched = false;
  let from = '';
  let branch = '';
  for (const r of repos) {
    const dir = repoDir(root, r);
    const where = r === '.' ? '' : `${r}: `;
    const current = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const detached = !current || current === 'HEAD';
    if (!detached && !isProtected(current, o.patterns)) {
      branch ||= current;
      continue;
    }
    from ||= detached ? 'a detached HEAD' : current;
    const why = detached ? 'HEAD was detached' : `${current} is protected`;
    if (git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0) {
      const res = git(dir, ['switch', name]);
      if (res.status !== 0) return { error: `${where}could not switch to ${name}: ${(res.stderr ?? '').trim()}` };
      switched = true;
      notes.push(`${where}${why}: switched to ${name}, this plan's branch`);
    } else {
      const which = baseOf(dir, current, o.bases?.[r]);
      if ('ambiguous' in which) {
        const key = r === '.' ? 'autopilot.base' : `autopilot.repos.${r}.base`;
        return { error: `${where}it has ${which.ambiguous.join(' and ')}: set which one features start from in ${key} (Config tab, or wololo init)` };
      }
      const base = which.base;
      const res = git(dir, ['switch', '-c', name, base]);
      if (res.status !== 0) return { error: `${where}could not create branch ${name} from ${base}: ${(res.stderr ?? '').trim()}` };
      created = true;
      notes.push(`${where}${why}: created branch ${name} from ${base}; the work lands there`);
    }
    branch ||= name;
  }
  if ((created || switched) && o.key) rememberBranch(root, o.key, name);
  return { branch, created, switched, from, notes };
}

/**
 * Last line of defence before wololo itself commits or merges: an agent may have checked out a
 * protected branch mid-run, in any repo. Returns why not, or '' when it is fine.
 * @param {string} root @param {string[]} [patterns]
 */
export function protectedHere(root, patterns) {
  for (const r of listRepos(root)) {
    const current = gitOut(repoDir(root, r), ['rev-parse', '--abbrev-ref', 'HEAD']);
    const where = r === '.' ? '' : ` in ${r}`;
    if (current === 'HEAD') return `refusing to commit on a detached HEAD${where}`;
    if (isProtected(current, patterns)) return `refusing to commit to ${current}${where}: it is protected (autopilot.protectedBranches). Check out the run's branch and resume`;
  }
  return '';
}

/** The configured base branch of each repo: autopilot.repos[name].base, and autopilot.base for a single repo ('.'). @param {import('../../core/config.js').Config} config */
export const repoBases = (config) => ({
  ...(config.autopilot.base ? { '.': config.autopilot.base } : {}),
  ...Object.fromEntries(Object.entries(config.autopilot.repos ?? {}).filter(([, v]) => v?.base).map(([k, v]) => [k, /** @type {string} */ (v.base)])),
});
