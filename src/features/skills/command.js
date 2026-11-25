import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { run } from '../../core/exec.js';
import { readText, writeText } from '../../core/files.js';
import { parseFrontmatter } from '../../core/frontmatter.js';
import { wololoPath } from '../../core/state.js';
import { templatePath } from '../../core/templates.js';
import { slugify } from '../../core/text.js';
import { interventions } from '../transcripts/parse.js';
import { sessionsFor } from '../transcripts/command.js';
import { loadSkills, subdirs } from '../sync/sources.js';
import { auditSkill } from './audit.js';

/** @param {string} name */
const usagePattern = (name) => new RegExp(`skills/${name}/SKILL\\.md|"skill"\\s*:\\s*"${name}"|Skill\\(${name}\\)|<command-name>/?${name}</command-name>`);

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'skills list',
    summary: 'List canonical skills in .wololo/skills.',
    async run(_input, ctx) {
      const skills = loadSkills(ctx.root);
      return { ok: true, summary: `${skills.length} skill(s)`, details: skills.map((s) => `${s.name} — ${s.description}`), data: skills.map((s) => ({ name: s.name, description: s.description })) };
    },
  },
  {
    name: 'skills new',
    summary: 'Scaffold a skill: a process written down in words, wrapped around deterministic tools.',
    args: [{ name: 'name', description: 'Skill name', required: true }],
    options: { description: { type: 'string', description: 'What it does and WHEN to use it' } },
    async run(input, ctx) {
      const name = slugify(input.name);
      const path = wololoPath(ctx.root, 'skills', name, 'SKILL.md');
      if (existsSync(path)) return { ok: false, summary: `skill ${name} exists` };
      const tmpl = readText(templatePath('skill.md')) ?? '';
      writeText(path, tmpl.replaceAll('{{name}}', name).replaceAll('{{description}}', input.description ?? `TODO: what ${name} does. Use when …`));
      return { ok: true, summary: `created .wololo/skills/${name}/SKILL.md — fill it in, then wololo sync` };
    },
  },
  {
    name: 'skills add',
    summary: 'Carry your own knives: import skills from a path or git repo (a SKILL.md folder or a folder of them).',
    args: [{ name: 'source', description: 'Local path or git URL', required: true }],
    options: { only: { type: 'string[]', description: 'Only these skill names' }, force: { type: 'boolean', description: 'Overwrite existing skills' } },
    async run(input, ctx) {
      let dir = resolve(ctx.cwd, input.source);
      let tmp;
      if (/^(https?:|git@|ssh:)/.test(input.source)) {
        tmp = mkdtempSync(join(tmpdir(), 'wololo-skills-'));
        const r = await run(['git', 'clone', '--depth', '1', input.source, tmp], { cwd: ctx.cwd, timeoutMs: 120_000 });
        if (r.code !== 0) return { ok: false, summary: `git clone failed: ${r.stderr.trim()}` };
        dir = tmp;
      }
      try {
        const candidates = findSkillDirs(dir).filter((d) => !input.only?.length || input.only.includes(basename(d)));
        const added = [];
        const skipped = [];
        for (const d of candidates) {
          const name = slugify(parseFrontmatter(readText(join(d, 'SKILL.md')) ?? '').data.name ?? basename(d));
          const dest = wololoPath(ctx.root, 'skills', name);
          if (existsSync(dest) && !input.force) {
            skipped.push(name);
            continue;
          }
          cpSync(d, dest, { recursive: true });
          added.push(name);
        }
        return { ok: added.length > 0, summary: `imported ${added.length} skill(s)${skipped.length ? `, skipped existing: ${skipped.join(', ')}` : ''}. Run wololo skills audit, then wololo sync`, details: added };
      } finally {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'skills audit',
    summary: 'Flag skill parts that should be deterministic (scripts, codemods) and skills that grew too big.',
    async run(_input, ctx) {
      const results = loadSkills(ctx.root).map(auditSkill);
      const flagged = results.filter((r) => r.findings.length);
      return {
        ok: true,
        summary: `${results.length} skill(s), ${flagged.length} with findings, ${results.reduce((a, r) => a + r.words, 0)} words total`,
        details: results.map((r) => `${r.name} (${r.lines} lines, ${r.words} words)${r.findings.map((f) => `\n    - ${f}`).join('')}`),
        data: results,
      };
    },
  },
  {
    name: 'skills stats',
    summary: 'Measure what each skill changes: human interventions per session with vs without it (from transcripts).',
    options: {
      dir: { type: 'string[]', description: 'Transcript dirs' },
      allProjects: { type: 'boolean', description: 'Include other projects' },
      days: { type: 'number', description: 'Look back days', default: 90 },
    },
    async run(input, ctx) {
      const sessions = sessionsFor(input, ctx);
      const ivCount = new Map(sessions.map((s) => [s, interventions(s).length]));
      /** @param {typeof sessions} list */
      const avg = (list) => (list.length ? list.reduce((a, s) => a + (ivCount.get(s) ?? 0), 0) / list.length : NaN);
      const rows = loadSkills(ctx.root).map((sk) => {
        const re = usagePattern(sk.name);
        const used = sessions.filter((s) => re.test(s.raw));
        const unused = sessions.filter((s) => !re.test(s.raw));
        const withIt = avg(used);
        const without = avg(unused);
        return { skill: sk.name, sessions: used.length, withIt, without, delta: withIt - without };
      });
      /** @param {number} n */
      const f = (n) => (Number.isNaN(n) ? '–' : n.toFixed(2));
      return {
        ok: true,
        summary: `${sessions.length} session(s) analysed. Lower interventions with a skill = it is pulling its weight`,
        details: rows.map((r) => `${r.skill}: used in ${r.sessions} — interventions/session ${f(r.withIt)} with vs ${f(r.without)} without${r.sessions < 3 ? ' (too little data)' : r.delta > 0 ? ' ⚠ not helping' : ''}`),
        data: rows,
      };
    },
  },
];

/** @param {string} dir @returns {string[]} */
function findSkillDirs(dir) {
  if (existsSync(join(dir, 'SKILL.md'))) return [dir];
  const out = [];
  for (const name of subdirs(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const sub = join(dir, name);
    if (statSync(sub).isDirectory()) out.push(...findSkillDirs(sub));
  }
  return out;
}
