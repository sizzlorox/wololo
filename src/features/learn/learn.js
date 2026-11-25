import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, readJson, writeJson } from '../../core/files.js';
import { spawnSync } from '../../core/proc.js';
import { statePath } from '../../core/state.js';
import { shortHash, truncate } from '../../core/text.js';
import { runAgent } from '../autopilot/agent.js';
import { agentArgv } from '../autopilot/argv.js';
import { listRuns, readRun } from '../autopilot/transcript.js';
import { readRuns } from '../autopilot/usage.js';
import { enqueue } from '../queue/store.js';
import { runSync } from '../sync/command.js';
import { detect, normalizeCall } from './detect.js';
import { baseRole, decide, learnedDir, listLearned, MAX_BODY, saveLearned } from './store.js';

/** Runs looked at for patterns: recent enough to reflect how the repo is built now. */
const WINDOW = 80;
const ROLES = ['builder', 'fixer', 'verifier', 'merger'];

/**
 * Recent agent runs with their normalized tool calls, step and turns.
 * @param {string} root
 * @returns {import('./detect.js').RunCalls[]}
 */
export function collectRuns(root) {
  const usage = new Map(readRuns(root).map((u) => [u.id, u]));
  return listRuns(root)
    .slice(0, WINDOW)
    .map((r) => {
      const u = /** @type {any} */ (usage.get(r.id));
      const calls = readRun(root, r.id)
        .filter((e) => e.kind === 'call')
        .map((e) => normalizeCall(e.tool ?? '', e.text, [root]));
      return { id: r.id, role: baseRole(r.role), task: u?.task, calls, turns: u?.turns ?? 0 };
    })
    .filter((r) => ROLES.includes(r.role) && r.calls.length);
}

/** @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].filter((x) => x > 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * @param {import('./detect.js').Pattern} p
 * @param {{ path: string }} o
 */
export function drafterPrompt(p, o) {
  return [
    'You are the skill writer in an autopilot loop. Agents building this repo keep repeating the same steps. Write it down once so later agents reuse it instead of working it out again.',
    '',
    `Repeated in ${p.runs.length} agent runs across ${p.tasks.length} steps (roles: ${p.roles.join(', ')}):`,
    ...p.calls.map((c, i) => `  ${i + 1}. ${c}`),
    '',
    'Look at the repo as much as you need, then choose the cheapest thing that removes the repetition:',
    '- "script": a small Node.js script (.mjs, no dependencies, works on Windows, macOS and Linux) that does the repeated steps and prints a short result. The body is one or two lines telling agents to run {{script}} and what its output means.',
    `- "skill": short, concrete instructions for agents doing this kind of work: what to run, what to check, the pitfalls. Under ${MAX_BODY} characters.`,
    '- "none": this is ordinary work (e.g. reading a file before editing it) and nothing reusable would save time.',
    'Say when it applies: "files", the files or dirs it is about ([] = any), and "roles", from builder, fixer, verifier, merger ([] = any). Narrow is better: it is only shown to matching agents.',
    '',
    `Write ${o.path} as JSON: {"kind": "script" | "skill" | "none", "title": "under 60 chars", "body": "...", "files": [], "roles": [], "script": "the .mjs source, only for kind script"}`,
    'Do not change any other file and do not commit.',
  ].join('\n');
}

/**
 * Validate a draft and adopt it on trial. Returns the item, or why it was not adopted.
 * @param {string} root @param {import('./detect.js').Pattern} p @param {any} d @param {number} baselineTurns
 * @returns {import('./store.js').Learned | string}
 */
export function adopt(root, p, d, baselineTurns) {
  if (!d || typeof d !== 'object') return 'no draft written';
  if (d.kind === 'none') return 'the skill writer found nothing reusable';
  if (d.kind !== 'skill' && d.kind !== 'script') return `unknown kind "${d.kind}"`;
  const title = typeof d.title === 'string' ? d.title.trim() : '';
  const body = typeof d.body === 'string' ? d.body.trim() : '';
  if (!title || !body) return 'the draft has no title or body';
  if (body.length > MAX_BODY) return `the body is ${body.length} characters (max ${MAX_BODY})`;
  if (d.kind === 'script' && (typeof d.script !== 'string' || !d.script.trim() || !body.includes('{{script}}'))) return 'a script draft needs the script and {{script}} in its body';
  const strings = (/** @type {unknown} */ x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
  const id = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${shortHash(p.key)}`;
  const dir = join(learnedDir(root), id);
  if (d.kind === 'script') {
    ensureDir(dir);
    writeFileSync(join(dir, 'run.mjs'), d.script);
    const check = spawnSync(process.execPath, ['--check', join(dir, 'run.mjs')], { encoding: 'utf8' });
    if (check.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      return `the script does not parse: ${truncate(check.stderr ?? '', 200)}`;
    }
  }
  /** @type {import('./store.js').Learned} */
  const item = {
    id,
    title: truncate(title, 60),
    kind: d.kind,
    body,
    trigger: { roles: strings(d.roles).filter((r) => ROLES.includes(r)), files: strings(d.files) },
    status: 'trial',
    evidence: { calls: p.calls, runs: p.runs, tasks: p.tasks, baselineTurns },
    created: new Date().toISOString(),
  };
  saveLearned(root, item);
  return item;
}

/**
 * After a step lands: judge trials, then look for a new repeated workflow and, in `auto` mode,
 * have one agent write it down and adopt it on trial (`suggest` only queues it). At most one new
 * skill per call, and each pattern is handled once.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} agent
 * @param {(msg: string) => void} log
 */
export async function learn(ctx, agent, log) {
  const { root, config } = ctx;
  const mode = config.autopilot.learn ?? 'auto';
  if (mode === 'off') return;

  const usage = readRuns(root);
  for (const item of listLearned(root)) {
    const verdict = decide(item, /** @type {any} */ (usage));
    if (!verdict) continue;
    saveLearned(root, { ...item, ...verdict, decided: new Date().toISOString() });
    log(`learned skill "${item.title}" ${verdict.status}: ${verdict.reason}`);
    enqueue(root, [{ title: `learned skill ${verdict.status}: ${item.title}`, body: verdict.reason, kind: 'finding', source: 'wololo', tags: ['learned'] }]);
  }

  const seenFile = statePath(root, 'learn.json');
  /** @type {{ handled: string[] }} */
  const seen = readJson(seenFile, { handled: [] });
  const known = new Set([...seen.handled, ...listLearned(root).map((i) => shortHash(i.evidence.calls.join('\n')))]);
  const runs = collectRuns(root);
  const p = detect(runs).find((x) => !known.has(shortHash(x.key)));
  if (!p) return;
  writeJson(seenFile, { handled: [...seen.handled, shortHash(p.key)] });
  const baseline = median(runs.filter((r) => p.runs.includes(r.id)).map((r) => r.turns ?? 0));
  const what = `${p.calls.length} step(s) repeated in ${p.runs.length} runs across ${p.tasks.length} steps: ${p.calls.join(' → ')}`;

  if (mode === 'suggest') {
    enqueue(root, [{ title: `repeated workflow: ${truncate(p.calls.join(' → '), 80)}`, body: `${what}\nSet autopilot.learn to "auto" to have wololo write it down as a skill.`, kind: 'finding', source: 'wololo', tags: ['learned'] }]);
    log(`noticed a repeated workflow (${what}); queued it (autopilot.learn = suggest)`);
    return;
  }

  log(`noticed a repeated workflow (${what}); the skill writer writes it down`);
  const path = statePath(root, 'learn-draft.json');
  ensureDir(statePath(root));
  rmSync(path, { force: true });
  await runAgent(ctx, agentArgv(config, agent, drafterPrompt(p, { path }), { root }), 'skill writer', log);
  let draft = null;
  try {
    draft = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    // not JSON: reported below
  }
  const r = adopt(root, p, draft, baseline);
  if (typeof r === 'string') {
    log(`no learned skill from it: ${r}`);
    return;
  }
  log(`learned skill on trial: "${r.title}" (${r.kind}; for ${r.trigger.roles.join(', ') || 'any role'} on ${r.trigger.files.join(', ') || 'any files'})`);
  // Claude Code also gets it as a manually invoked skill; keep the generated files in sync for the gate
  runSync(ctx, {});
}
