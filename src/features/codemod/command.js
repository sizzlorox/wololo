import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listFiles, readText, writeText } from '../../core/files.js';
import { matchAny } from '../../core/glob.js';
import { recordEvent, wololoPath } from '../../core/state.js';
import { templatePath } from '../../core/templates.js';
import { slugify } from '../../core/text.js';
import { normalize } from '../check/engine.js';
import { generatedPaths } from '../sync/manifest.js';
import { runVerify } from '../verify/command.js';

/**
 * @typedef {{ description?: string, files: string | string[], transform: (source: string, info: { path: string }) => string | null | undefined | Promise<string | null | undefined> }} Codemod
 */

/** @param {string} root */
function names(root) {
  try {
    return readdirSync(wololoPath(root, 'codemods')).filter((n) => /\.m?js$/.test(n)).map((n) => n.replace(/\.m?js$/, '')).sort();
  } catch {
    return [];
  }
}

/** @param {string} root @param {string} name @returns {Promise<Codemod>} */
async function load(root, name) {
  const file = ['.mjs', '.js'].map((e) => wololoPath(root, 'codemods', `${name}${e}`)).find((f) => existsSync(f));
  if (!file) throw new Error(`no codemod ${name} in .wololo/codemods`);
  return import(`${pathToFileURL(file).href}?t=${Date.now()}`);
}

/**
 * @param {string} before
 * @param {string} after
 */
function lineDelta(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let changed = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed++;
  return changed;
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'codemod list',
    summary: 'List codemods. Migrations are deterministic transforms, not agent rewrites.',
    async run(_input, ctx) {
      const list = await Promise.all(names(ctx.root).map(async (n) => ({ name: n, description: (await load(ctx.root, n)).description ?? '' })));
      return { ok: true, summary: `${list.length} codemod(s)`, details: list.map((c) => `${c.name} — ${c.description}`), data: list };
    },
  },
  {
    name: 'codemod new',
    summary: 'Scaffold .wololo/codemods/<name>.mjs (plug in ts-morph, jscodeshift, ast-grep, libcst… as needed).',
    args: [{ name: 'name', description: 'Codemod name', required: true }],
    async run(input, ctx) {
      const name = slugify(input.name);
      const path = wololoPath(ctx.root, 'codemods', `${name}.mjs`);
      if (existsSync(path)) return { ok: false, summary: `codemod ${name} exists` };
      writeText(path, readText(templatePath('codemod.mjs')) ?? '');
      return { ok: true, summary: `created .wololo/codemods/${name}.mjs — write the transform, dry-run, then --write` };
    },
  },
  {
    name: 'codemod run',
    summary: 'Apply a codemod. Dry-run by default; --write applies it and runs verify.',
    args: [
      { name: 'name', description: 'Codemod name', required: true },
      { name: 'files', description: 'Limit to these files', variadic: true },
    ],
    options: { write: { type: 'boolean', description: 'Write changes' }, verify: { type: 'boolean', description: 'Run verify after writing', default: true } },
    async run(input, ctx) {
      const mod = await load(ctx.root, input.name);
      const generated = new Set(generatedPaths(ctx.root));
      const pool = input.files?.length ? input.files.map((/** @type {string} */ f) => normalize(ctx, f)) : listFiles(ctx.root, ctx.config.ignore);
      const targets = pool.filter((/** @type {string} */ f) => matchAny(f, mod.files) && !generated.has(f));
      const changes = [];
      for (const file of targets) {
        const before = readText(join(ctx.root, file)) ?? '';
        const after = await mod.transform(before, { path: file });
        if (typeof after !== 'string' || after === before) continue;
        changes.push({ file, lines: lineDelta(before, after) });
        if (input.write) writeText(join(ctx.root, file), after);
      }
      const details = changes.map((c) => `${input.write ? 'changed' : 'would change'} ${c.file} (${c.lines} lines)`);
      let ok = true;
      if (input.write && changes.length && input.verify) {
        const v = await runVerify(ctx, { fast: true });
        ok = v.ok;
        details.push(v.ok ? 'fast verify: PASS' : `fast verify: FAIL (${v.results.filter((r) => !r.ok).map((r) => r.name).join(', ')}) — fix the codemod, not the output`);
      }
      recordEvent(ctx.root, { type: 'codemod', ok, name: input.name, files: changes.length, write: !!input.write });
      return { ok, summary: `${input.name}: ${changes.length}/${targets.length} file(s) ${input.write ? 'changed' : 'would change (dry run)'}`, details, data: changes };
    },
  },
];
