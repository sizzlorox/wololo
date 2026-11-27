import { join } from 'node:path';
import { readJson, writeJson } from '../../core/files.js';
import { CONFIG_FILE } from '../../core/state.js';
import { detect } from '../init/detect.js';
import { scriptsRun } from './contract.js';

/**
 * Verification grows with the project. When the project gains a test suite, a type checker, a build
 * or something people look at, the gate must run it: a gate that checks one file while the app grows
 * a renderer is how two days of green gates shipped a renderer that draws nothing.
 */

/**
 * Detected checks the configured steps do not run. A step covers a detected one when it runs the
 * same command, or runs it through package.json scripts; any app step covers the detected app step.
 * @param {string} root @param {import('../../core/config.js').VerifyStep[]} steps
 * @returns {import('../../core/config.js').VerifyStep[]}
 */
export function uncovered(root, steps) {
  const scripts = readJson(join(root, 'package.json'), /** @type {any} */ ({})).scripts ?? {};
  const runs = steps.map((s) => s.run ?? '').filter(Boolean);
  const reached = new Set(runs.flatMap((r) => Object.keys(scriptsRun(r, scripts))));
  const bodies = new Set([...runs, ...[...reached].map((n) => scripts[n])].map((r) => r.trim()));
  return detect(root).steps.filter((d) => {
    if (d.app) return !steps.some((s) => s.app);
    const run = (d.run ?? '').trim();
    const script = Object.keys(scriptsRun(run, scripts))[0];
    return !(bodies.has(run) || (script && (reached.has(script) || bodies.has(scripts[script]?.trim()))));
  });
}

/** Words that say a step changes what people see. */
const VISUAL = /\b(render(er|ing)?|screens?|ui|hud|menus?|sprites?|assets?|art|artwork|visuals?|draw(ing|s)?|display|camera|animations?|windows?|pages?|layout|css|styles?|themes?|icons?|images?|textures?|tiles?|screenshots?|graphics|dashboard)\b/i;

/** @param {string} text  a step's title and body */
export const seenByPeople = (text) => VISUAL.test(text);

/**
 * Add the uncovered checks to wololo.config.json (adding is always allowed; only removing needs a human).
 * A name already taken by a different step gets a suffix, so nothing configured is replaced.
 * @param {string} root
 * @returns {import('../../core/config.js').VerifyStep[]} what was added
 */
export function adoptMissing(root) {
  const path = join(root, CONFIG_FILE);
  const raw = readJson(path, /** @type {any} */ ({}));
  /** @type {import('../../core/config.js').VerifyStep[]} */
  const steps = raw.verify?.steps ?? [];
  const add = uncovered(root, steps).map((s) => {
    let name = s.name;
    for (let i = 2; steps.some((x) => x.name === name); i++) name = `${s.name}-${i}`;
    return { ...s, name };
  });
  if (add.length) writeJson(path, { ...raw, verify: { ...raw.verify, steps: [...steps, ...add] } });
  return add;
}
