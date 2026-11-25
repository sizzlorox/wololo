import { join } from 'node:path';
import { loadConfig } from '../../core/config.js';
import { readJson, writeJson } from '../../core/files.js';
import { CONFIG_FILE } from '../../core/state.js';
import { detect } from '../init/detect.js';
import { runSync } from '../sync/command.js';

/**
 * Re-read the config between agent runs (agents may edit it). A project initialised empty has no
 * verify steps, so the gate could never pass: once the builder has created the project, adopt the
 * detected steps, exactly as init would have.
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
  if (config.verify.steps.length) return { ...ctx, config };
  const found = detect(ctx.root);
  if (!found.steps.length) return { ...ctx, config };
  const path = join(ctx.root, CONFIG_FILE);
  const raw = readJson(path, /** @type {any} */ ({}));
  raw.verify = { ...raw.verify, steps: found.steps };
  if (!raw.ci?.setup?.length) raw.ci = { ...raw.ci, setup: found.setup };
  writeJson(path, raw);
  config = loadConfig(ctx.root);
  runSync({ ...ctx, config }, {});
  log(`adopted verify steps: ${found.steps.map((s) => s.name).join(', ')} (detected ${found.stack.join('+')}; review them in ${CONFIG_FILE})`);
  return { ...ctx, config };
}
