import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readText, writeText } from '../../core/files.js';
import { hashOf, readManifest, writeManifest } from './manifest.js';
import { buildOps, groupByPath, render } from './plan.js';
import { ADAPTERS } from '../../adapters/index.js';

/**
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ check?: boolean, force?: boolean }} opts
 */
export function runSync(ctx, opts) {
  const { root } = ctx;
  const previous = readManifest(root).files;
  /** @type {Record<string, string>} */
  const next = {};
  const out = { written: /** @type {string[]} */ ([]), drift: /** @type {string[]} */ ([]), conflicts: /** @type {string[]} */ ([]), removed: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]), unchanged: 0 };

  for (const [path, ops] of groupByPath(buildOps(ctx))) {
    const abs = join(root, path);
    const existing = readText(abs);
    let desired;
    try {
      desired = render(ops, existing);
    } catch (e) {
      out.errors.push(`${path}: cannot merge (${/** @type {Error} */ (e).message})`);
      continue;
    }
    const owned = ops.every((o) => o.kind === 'write');
    if (owned) next[path] = hashOf(desired);
    if (desired === existing) {
      out.unchanged++;
      continue;
    }
    const handEdited = owned && existing !== undefined && previous[path] !== hashOf(existing);
    if (handEdited && !opts.force) {
      out.conflicts.push(path);
      if (previous[path]) next[path] = previous[path];
      else delete next[path];
      continue;
    }
    if (opts.check) out.drift.push(path);
    else {
      writeText(abs, desired);
      out.written.push(path);
    }
  }

  for (const path of Object.keys(previous)) {
    if (path in next) continue;
    const abs = join(root, path);
    if (!existsSync(abs)) continue;
    if (hashOf(readText(abs) ?? '') !== previous[path] && !opts.force) {
      out.conflicts.push(`${path} (stale but hand-edited)`);
      next[path] = previous[path];
    } else if (opts.check) out.drift.push(`${path} (stale)`);
    else {
      rmSync(abs);
      out.removed.push(path);
    }
  }

  if (!opts.check) writeManifest(root, next);
  const ok = out.drift.length === 0 && out.conflicts.length === 0 && out.errors.length === 0;
  return { ok, ...out };
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'sync',
    summary: 'Generate harness adapters (AGENTS.md, skills, agents, MCP, hooks) from .wololo/. --check fails on drift.',
    options: {
      check: { type: 'boolean', description: 'Report drift without writing (CI)' },
      force: { type: 'boolean', description: 'Overwrite hand-edited generated files' },
    },
    async run(input, ctx) {
      const r = runSync(ctx, { check: input.check, force: input.force });
      const notes = ctx.config.harnesses.flatMap((h) => (ADAPTERS[h]?.notes ?? []).map((n) => `note (${h}): ${n}`));
      const details = [
        ...r.written.map((p) => `wrote ${p}`),
        ...r.removed.map((p) => `removed ${p}`),
        ...r.drift.map((p) => `drift ${p}`),
        ...r.conflicts.map((p) => `conflict ${p}: generated file was edited by hand. Move the change into .wololo/ then re-run, or --force`),
        ...r.errors,
        ...(input.check ? [] : notes),
      ];
      const summary = input.check
        ? r.ok
          ? 'adapters in sync'
          : `adapters out of sync (${r.drift.length} drift, ${r.conflicts.length} conflicts${r.errors.length ? `, ${r.errors.length} errors` : ''}): run wololo sync`
        : `sync: ${r.written.length} written, ${r.removed.length} removed, ${r.unchanged} unchanged${r.conflicts.length ? `, ${r.conflicts.length} conflicts` : ''}`;
      return { ok: r.ok, summary, details, data: r };
    },
  },
];
