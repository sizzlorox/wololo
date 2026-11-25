import { parseFrontmatter } from '../../core/frontmatter.js';

/**
 * Audit a skill for parts that should be deterministic, and for bloat.
 * Skills describe workflows; scripts do the mechanical work.
 * @param {import('../../adapters/types.js').Skill} skill
 */
export function auditSkill(skill) {
  const main = skill.files.find((f) => f.rel === 'SKILL.md')?.content ?? '';
  const { data, body } = parseFrontmatter(main);
  const lines = body.split('\n');
  const findings = [];

  if (data.name && data.name !== skill.name) findings.push(`frontmatter name "${data.name}" ≠ folder "${skill.name}"`);
  if (!data.name) findings.push('missing frontmatter name');
  if (!data.description) findings.push('missing description: agents pick skills by description');
  else if (data.description.length > 1024) findings.push('description over 1024 chars');
  else if (!/\b(use|when|before|after)\b/i.test(data.description)) findings.push('description should say WHEN to use the skill');

  let inFence = false;
  let fenceIsShell = false;
  let shellLines = 0;
  for (const l of lines) {
    const fence = /^\s*```(\w*)/.exec(l);
    if (fence) {
      inFence = !inFence;
      fenceIsShell = inFence && ['', 'sh', 'bash', 'shell', 'console', 'zsh', 'powershell'].includes(fence[1]);
      continue;
    }
    if (inFence && fenceIsShell && l.trim()) shellLines++;
  }
  if (shellLines >= 4) findings.push(`${shellLines} shell lines: mechanical work belongs in a script or CLI, leave judgment in the skill`);

  const commandSteps = lines.filter((l) => /^\s*\d+\.\s.*`[^`]{6,}`/.test(l)).length;
  if (commandSteps >= 4) findings.push(`${commandSteps} numbered command steps: candidate for a single deterministic command`);

  if (lines.some((l) => /\b(rename|replace|update)\b.*\b(across|in all|every|each)\b.*\b(file|files|call ?sites|imports?)\b/i.test(l)))
    findings.push('describes a bulk rewrite: use a codemod (wololo codemod new), not agent edits');

  const words = body.split(/\s+/).filter(Boolean).length;
  if (lines.length > 120) findings.push(`${lines.length} lines: skills should describe the workflow, not implementation details`);

  return { name: skill.name, lines: lines.length, words, shellLines, findings };
}
