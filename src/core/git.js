// The one way to run git (rule: one-way-helpers).
import { spawnSync } from './proc.js';

/**
 * Run git in a directory; never throws. Large buffer: diffs and file lists can be big.
 * @param {string} cwd @param {string[]} args
 */
export const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** git's output, trimmed; '' when it fails. @param {string} cwd @param {string[]} args */
export const gitOut = (cwd, args) => (git(cwd, args).stdout ?? '').trim();
