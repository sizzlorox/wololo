import { readFileSync } from 'node:fs';

/** wololo's own version, from its package.json. */
export const VERSION = /** @type {string} */ (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
