import { readJson, writeJson } from '../../core/files.js';
import { git, gitOut } from '../../core/git.js';
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

/**
 * Put the repo on a branch autopilot may commit to. On a protected branch (or a detached HEAD):
 * the plan's own branch if it has one, else a new one named after the goal in the repo's style.
 * The checked-out branch is kept otherwise. Uncommitted changes come along; if git refuses, no run.
 * @param {string} root @param {string} goal
 * @param {{ key?: string, patterns?: string[] }} [o]  key: the plan (group) this run belongs to
 * @returns {{ branch: string, created?: boolean, switched?: boolean, from?: string } | { error: string }}
 */
export function ensureBranch(root, goal, o = {}) {
  const current = gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const detached = !current || current === 'HEAD';
  if (!detached && !isProtected(current, o.patterns)) return { branch: current };
  const remembered = o.key ? /** @type {Record<string, string>} */ (readJson(plansFile(root), {}))[o.key] : undefined;
  if (remembered && !isProtected(remembered, o.patterns) && git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${remembered}`]).status === 0) {
    const r = git(root, ['switch', remembered]);
    if (r.status !== 0) return { error: `could not switch to ${remembered}: ${(r.stderr ?? '').trim()}` };
    return { branch: remembered, switched: true, from: detached ? 'a detached HEAD' : current };
  }
  const existing = gitOut(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).split('\n').filter(Boolean);
  const name = branchFor(goal, existing);
  const r = git(root, ['switch', '-c', name]);
  if (r.status !== 0) return { error: `could not create branch ${name}: ${(r.stderr ?? '').trim()}` };
  if (o.key) rememberBranch(root, o.key, name);
  return { branch: name, created: true, from: detached ? 'a detached HEAD' : current };
}

/**
 * Last line of defence before wololo itself commits or merges: an agent may have checked out a
 * protected branch mid-run. Returns why not, or '' when it is fine.
 * @param {string} root @param {string[]} [patterns]
 */
export function protectedHere(root, patterns) {
  const current = gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current === 'HEAD') return 'refusing to commit on a detached HEAD';
  return isProtected(current, patterns) ? `refusing to commit to ${current}: it is protected (autopilot.protectedBranches). Check out the run's branch and resume` : '';
}
