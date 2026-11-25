// A codemod: deterministic, reviewable, re-runnable. Prefer this to asking an agent to edit N files.
// Bring a real AST tool when regex is not enough, e.g.:
//   import { Project } from 'ts-morph';            (TypeScript)
//   import jscodeshift from 'jscodeshift';         (JS/TS)
//   import { parse, Lang } from '@ast-grep/napi';  (many languages)

export const description = 'Describe the migration in one line';

/** Globs (repo-relative) this codemod may touch. */
export const files = ['src/**/*.{js,ts,jsx,tsx}'];

/**
 * Return the new source, or undefined to leave the file untouched.
 * @param {string} source
 * @param {{ path: string }} info
 */
export function transform(source, info) {
  void info;
  const next = source.replace(/\boldName\(/g, 'newName(');
  return next === source ? undefined : next;
}
