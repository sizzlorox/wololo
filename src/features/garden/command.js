import { spawnSync } from '../../core/proc.js';
import { join } from 'node:path';
import { listFiles, readText } from '../../core/files.js';
import { wololoPath } from '../../core/state.js';
import { age } from '../../core/text.js';
import { readTasks } from '../board/store.js';
import { runCheck } from '../check/engine.js';
import { applies, loadRules } from '../check/rules.js';
import { enqueue } from '../queue/store.js';
import { readReviews } from '../review/store.js';
import { auditSkill } from '../skills/audit.js';
import { generatedPaths } from '../sync/manifest.js';
import { runSync } from '../sync/command.js';
import { loadSkills } from '../sync/sources.js';

/**
 * @typedef {{ id: string, title: string, body: string }} Finding
 */

/**
 * Codebase and environment health, as a list of small, independent chores.
 * @param {import('../../core/types.js').Ctx} ctx
 * @returns {Finding[]}
 */
export function gardenFindings(ctx) {
  const { root, config } = ctx;
  /** @type {Finding[]} */
  const out = [];

  const check = runCheck(ctx, { record: false });
  /** @type {Map<string, import('../check/rules.js').Violation[]>} */
  const byRule = new Map();
  for (const v of check.violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
  for (const [rule, vs] of byRule) out.push({ id: `rule:${rule}`, title: `${vs.length} ${rule} violation(s)`, body: vs.slice(0, 10).map((v) => `${v.file}${v.line ? `:${v.line}` : ''}`).join('\n') });

  const maxRule = loadRules(root).rules.find((r) => r.kind === 'max-lines');
  const generated = new Set(generatedPaths(root));
  const files = listFiles(root, config.ignore).filter((f) => !generated.has(f));
  if (maxRule?.max) {
    const budget = maxRule.max;
    const near = files
      .filter((f) => applies(maxRule, f))
      .map((f) => ({ f, n: (readText(join(root, f)) ?? '').split('\n').length }))
      .filter((x) => x.n > budget * 0.8 && x.n <= budget);
    for (const x of near) out.push({ id: `near-god:${x.f}`, title: `${x.f} is at ${x.n}/${budget} lines`, body: 'Split it before it becomes a god file.' });
  }

  let todos = 0;
  for (const f of files) if (/\.(m?[jt]sx?|py|go|rs|rb|java|kt|swift|cs|php)$/.test(f)) todos += ((readText(join(root, f)) ?? '').match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length;
  if (todos) out.push({ id: 'todos', title: `${todos} TODO/FIXME/HACK marker(s)`, body: 'Resolve, delete, or turn into queue items.' });

  const sync = runSync(ctx, { check: true });
  if (!sync.ok) out.push({ id: 'adapter-drift', title: 'harness adapters drifted from .wololo/', body: [...sync.drift, ...sync.conflicts].join('\n') });

  for (const a of loadSkills(root).map(auditSkill)) if (a.findings.length) out.push({ id: `skill:${a.name}`, title: `skill ${a.name}: ${a.findings[0]}`, body: a.findings.join('\n') });

  const verifyApp = readText(wololoPath(root, 'skills', 'verify-app', 'SKILL.md'));
  if (verifyApp?.includes('TODO(wololo)')) out.push({ id: 'verify-app:todo', title: 'verify-app skill still has TODO(wololo) placeholders', body: 'Agents cannot see or drive the app until it is filled in.' });
  else if (verifyApp) {
    const since = spawnSync('git', ['rev-list', '--count', 'HEAD', `^${lastTouch(root, '.wololo/skills/verify-app')}`], { cwd: root, encoding: 'utf8' }).stdout?.trim();
    if (Number(since) > 50) out.push({ id: 'verify-app:stale', title: `verify-app skill untouched for ${since} commits`, body: 'Re-run it end to end and update what changed.' });
  }
  if (!config.verify.steps.length) out.push({ id: 'verify:none', title: 'no verify steps configured', body: 'Without verification you are the meat proxy.' });

  for (const t of readTasks(root)) {
    const idle = Date.now() - Date.parse(t.updated);
    if (t.status === 'claimed' && idle > 864e5) out.push({ id: `stale-task:${t.id}`, title: `task ${t.id} claimed by ${t.agent} with no update for ${age(idle)}`, body: t.title });
  }
  const pending = readReviews(root).items.filter((r) => r.status === 'pending').length;
  if (pending) out.push({ id: 'reviews:pending', title: `${pending} sampled commit(s) awaiting review`, body: 'wololo review list' });
  return out;
}

/** @param {string} root @param {string} path */
function lastTouch(root, path) {
  return spawnSync('git', ['log', '-1', '--format=%H', '--', path], { cwd: root, encoding: 'utf8' }).stdout?.trim() || 'HEAD';
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'garden',
    summary: 'List small health chores (rule violations, near-god files, TODOs, drift, stale skills/tasks). --enqueue buffers them.',
    options: { enqueue: { type: 'boolean', description: 'Add findings to the queue (deduplicated)' } },
    async run(input, ctx) {
      const findings = gardenFindings(ctx);
      const added = input.enqueue ? enqueue(ctx.root, findings.map((f) => ({ kind: 'garden', source: 'garden', id: f.id, title: f.title, body: f.body }))) : [];
      return {
        ok: true,
        summary: `${findings.length} gardening chore(s)${input.enqueue ? `, ${added.length} newly queued` : ''}`,
        details: findings.map((f) => `${f.title}${f.body ? `\n    ${f.body.split('\n').slice(0, 3).join('\n    ')}` : ''}`),
        data: findings,
      };
    },
  },
];
