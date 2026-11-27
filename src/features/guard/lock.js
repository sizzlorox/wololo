import { readJson, writeJson } from '../../core/files.js';
import { statePath } from '../../core/state.js';
import { compare, contractOf } from './contract.js';

/**
 * The locked contract lives in the main checkout's state (a parallel worker reads it through
 * WOLOLO_STATE), not in the repo: an agent's branch cannot carry a loosened copy of it.
 * ponytail: per checkout, so CI starts from a fresh lock; commit it if CI must enforce the ratchet too.
 *
 * @typedef {{ at: string, by: string, contract: import('./contract.js').Contract }} Lock
 */
const file = (/** @type {string} */ root) => statePath(root, 'verify-lock.json');

/** @param {string} root @returns {Lock | null} */
export const readLock = (root) => readJson(file(root), /** @type {Lock | null} */ (null));

/** @param {string} root @param {import('./contract.js').Contract} contract @param {string} by */
export function writeLock(root, contract, by) {
  writeJson(file(root), { at: new Date().toISOString(), by, contract });
}

/**
 * Agents run with WOLOLO_AGENT set: they may raise the bar, never lower it.
 * @returns {string | undefined} why the caller may not approve a weakening
 */
export const notHuman = () => (process.env.WOLOLO_AGENT ? 'agents cannot approve a weaker gate; a human runs `wololo verify approve`' : undefined);

/**
 * Check the working tree against the lock. With no lock yet, today's contract becomes the lock.
 * A parallel worker checks against its branch's base commit instead: its branch predates steps
 * merged since, whose tests it simply does not have yet. The merged result is checked against the
 * lock by the main process, so nothing slips through between the two.
 * @param {import('../../core/types.js').Ctx} ctx @param {{ base?: string }} [opts]
 * @returns {{ ok: boolean, weakened: string[], added: string[], contract: import('./contract.js').Contract }}
 */
export function ratchet(ctx, opts = {}) {
  const contract = contractOf(ctx);
  if (process.env.WOLOLO_WORKER && opts.base) {
    const { weakened, added } = compare(contractOf(ctx, opts.base), contract);
    return { ok: weakened.length === 0, weakened, added, contract };
  }
  const lock = readLock(ctx.root);
  if (!lock) {
    writeLock(ctx.root, contract, 'first gate run');
    return { ok: true, weakened: [], added: [], contract };
  }
  const { weakened, added } = compare(lock.contract, contract);
  return { ok: weakened.length === 0, weakened, added, contract };
}

/**
 * Raise the lock to what landed: only ever after a green gate with nothing weakened, so the bar
 * moves up with the project and never down.
 * @param {import('../../core/types.js').Ctx} ctx @param {string} by
 */
export function raise(ctx, by) {
  const r = ratchet(ctx);
  if (r.ok) writeLock(ctx.root, r.contract, by);
  return r;
}
