import { join } from 'node:path';
import { loadConfig } from '../../core/config.js';
import { readJson, writeJson } from '../../core/files.js';
import { CONFIG_FILE } from '../../core/state.js';
import { detect } from '../init/detect.js';
import { runSync } from '../sync/command.js';
import { adoptMissing } from '../guard/coverage.js';

/**
 * Re-read the config between agent runs (agents may edit it), and let verification grow with the
 * project: every check detection finds that the gate does not run yet (a test suite the builder just
 * created, a build, an app to open) is adopted, exactly as init would have. A parallel worker leaves
 * this to the main process, which adopts on the merged result before gating it.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {(msg: string) => void} log
 * @returns {import('../../core/types.js').Ctx}
 */
export function refreshConfig(ctx, log) {
  let config;
  try {
    config = loadConfig(ctx.root);
  } catch (e) {
    log(`keeping the previous config: ${/** @type {Error} */ (e).message}`);
    return ctx;
  }
  if (process.env.WOLOLO_WORKER) return { ...ctx, config };
  const empty = !config.verify.steps.length;
  const added = adoptMissing(ctx.root);
  if (!added.length) return { ...ctx, config };
  const path = join(ctx.root, CONFIG_FILE);
  const raw = readJson(path, /** @type {any} */ ({}));
  if (empty && !raw.ci?.setup?.length) writeJson(path, { ...raw, ci: { ...raw.ci, setup: detect(ctx.root).setup } });
  config = loadConfig(ctx.root);
  runSync({ ...ctx, config }, {});
  log(`verification grew with the project: ${added.map((s) => `${s.name} (${s.run ?? 'opens the app'})`).join(', ')}; review them in ${CONFIG_FILE}`);
  return { ...ctx, config };
}
