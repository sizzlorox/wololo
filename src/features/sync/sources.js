import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readText, toPosix, walk } from '../../core/files.js';
import { parseFrontmatter } from '../../core/frontmatter.js';
import { wololoPath } from '../../core/state.js';

/**
 * Canonical skills: .wololo/skills/<name>/SKILL.md (+ any supporting files).
 * @param {string} root
 * @returns {import('../../adapters/types.js').Skill[]}
 */
export function loadSkills(root) {
  const dir = wololoPath(root, 'skills');
  return subdirs(dir).flatMap((name) => {
    const skillDir = join(dir, name);
    const main = readText(join(skillDir, 'SKILL.md'));
    if (main === undefined) return [];
    const { data } = parseFrontmatter(main);
    const files = walk(skillDir, skillDir).sort().map((rel) => ({ rel: toPosix(rel), content: readText(join(skillDir, rel)) ?? '' }));
    return [{ name, description: data.description ?? '', files }];
  });
}

/**
 * Canonical agents: .wololo/agents/<name>.md with name/description frontmatter.
 * @param {string} root
 * @returns {import('../../adapters/types.js').AgentDef[]}
 */
export function loadAgents(root) {
  const dir = wololoPath(root, 'agents');
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return names.map((file) => {
    const { data, body } = parseFrontmatter(readText(join(dir, file)) ?? '');
    return { name: data.name ?? file.replace(/\.md$/, ''), description: data.description ?? '', body };
  });
}

/** @param {string} dir */
export function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

