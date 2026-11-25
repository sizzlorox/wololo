import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS } from '../../adapters/index.js';
import { HARNESSES, loadConfig } from '../../core/config.js';
import { readJson, readText, walk, writeJson, writeText } from '../../core/files.js';
import { CONFIG_FILE, wololoPath } from '../../core/state.js';
import { templatePath } from '../../core/templates.js';
import { runSync } from '../sync/command.js';
import { detect } from './detect.js';
import { detectHarnesses, interviewApp, interviewHarnesses, renderVerifyApp } from './interview.js';

/** Template folders copied into .wololo/ (user-owned afterwards: sharpen them). */
const SEEDS = ['skills', 'agents', 'rules', 'rubric.json'];

/** @param {string} root */
function defaultBin(root) {
  const pkg = readJson(join(root, 'package.json'), /** @type {any} */ (null));
  if (pkg?.name === 'wololo') return 'node bin/wololo.js';
  // installed into the project: run that copy; otherwise the global install (npm i -g github:sizzlorox/wololo).
  // Not `npx github:…`: npx caches GitHub packages and keeps running the first version it downloaded.
  return pkg?.devDependencies?.wololo || pkg?.dependencies?.wololo ? 'npx --no-install wololo' : 'wololo';
}

/**
 * The first chosen harness autopilot can drive headlessly.
 * @param {string[]} harnesses
 */
const headlessAgent = (harnesses) => harnesses.find((h) => ADAPTERS[h]?.headless);

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'init',
    summary: 'Set up the kitchen: wololo.config.json, .wololo/ (skills, agents, rules, rubric), then sync every harness.',
    mcp: false,
    options: {
      harness: { type: 'string[]', description: `Harnesses to wire (default all: ${HARNESSES.join(', ')})` },
      bin: { type: 'string', description: 'How agents invoke wololo (default inferred)' },
      ci: { type: 'string', description: 'github | none', default: 'github' },
      force: { type: 'boolean', description: 'Overwrite existing seeds' },
      yes: { type: 'boolean', description: 'Do not ask questions; accept detected defaults (automatic when not in a terminal)' },
    },
    async run(input, ctx) {
      const { root } = ctx;
      const created = [];
      const configPath = join(root, CONFIG_FILE);
      const found = detect(root);
      const ask = input.yes ? undefined : ctx.prompt;
      let harnesses = input.harness?.length ? input.harness.filter((/** @type {string} */ h) => /** @type {readonly string[]} */ (HARNESSES).includes(h)) : [...HARNESSES];
      if (ask && !input.harness?.length && (!existsSync(configPath) || input.force)) {
        harnesses = await interviewHarnesses(ask, detectHarnesses(root));
        if (!found.steps.length) {
          const test = await ask('No verify steps detected. Command that runs your tests?');
          const fast = await ask('A fast check (lint/typecheck) to run on every stop? (blank for none)');
          if (fast) found.steps.push({ name: 'check', run: fast, fast: true });
          if (test) found.steps.push({ name: 'test', run: test });
        }
      }
      if (!existsSync(configPath) || input.force) {
        const pkg = readJson(join(root, 'package.json'), /** @type {any} */ (null));
        writeJson(configPath, {
          $schema: pkg?.name === 'wololo' ? './schema/wololo.config.schema.json' : './node_modules/wololo/schema/wololo.config.schema.json',
          project: typeof pkg?.name === 'string' ? pkg.name : ctx.config.project,
          bin: input.bin ?? defaultBin(root),
          harnesses,
          verify: { steps: found.steps },
          gate: { minScore: 0.8 },
          autopilot: { agent: headlessAgent(harnesses) ?? 'claude', verifiers: 1, maxIterations: 5 },
          sources: [],
          ci: { provider: input.ci === 'none' ? 'none' : 'github', setup: found.setup },
        });
        created.push(CONFIG_FILE);
      } else if (input.harness?.length && harnesses.length) {
        const existing = readJson(configPath, /** @type {any} */ ({}));
        const merged = [...new Set([...(existing.harnesses ?? []), ...harnesses])];
        const agent = harnesses.includes(existing.autopilot?.agent) ? existing.autopilot.agent : headlessAgent(harnesses) ?? existing.autopilot?.agent;
        if (merged.length !== (existing.harnesses ?? []).length || agent !== existing.autopilot?.agent) {
          writeJson(configPath, { ...existing, harnesses: merged, autopilot: { ...existing.autopilot, agent } });
          created.push(`${CONFIG_FILE} (harnesses = ${merged.join(', ')}; autopilot.agent = ${agent})`);
        }
      }
      for (const seed of SEEDS) {
        const src = templatePath(seed);
        const files = seed.includes('.') ? [''] : walk(src, src);
        for (const rel of files) {
          const from = rel ? join(src, rel) : src;
          const to = rel ? wololoPath(root, seed, rel) : wololoPath(root, seed);
          if (existsSync(to) && !input.force) continue;
          cpSync(from, to);
          created.push(`.wololo/${seed}${rel ? `/${rel}` : ''}`);
        }
      }
      const appSkill = wololoPath(root, 'skills', 'verify-app', 'SKILL.md');
      let appFilled = !(readText(appSkill) ?? '').includes('TODO(wololo)');
      if (ask && !appFilled) {
        ctx.say?.('\nverify-app: hands and eyes for your app. Press enter to accept a suggestion; leave blank to fill in later.');
        writeText(appSkill, renderVerifyApp(readText(appSkill) ?? '', await interviewApp(ask, root)));
        appFilled = !(readText(appSkill) ?? '').includes('TODO(wololo)');
      }
      const gi = join(root, '.gitignore');
      const ignore = readText(gi) ?? '';
      if (!ignore.split('\n').includes('.wololo/state/')) {
        writeText(gi, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}.wololo/state/\n`);
        created.push('.gitignore (+ .wololo/state/)');
      }
      const config = loadConfig(root);
      const sync = runSync({ ...ctx, config, hasConfig: true }, { force: input.force });
      const nextSteps = [
        found.steps.length ? `detected ${found.stack.join('+') || 'project'}: ${found.steps.map((s) => s.name).join(', ')} → review verify.steps in ${CONFIG_FILE}` : `no verify steps detected: add them to ${CONFIG_FILE} (nothing is verified until you do)`,
        ...(appFilled ? [] : ['finish .wololo/skills/verify-app/SKILL.md (or ask your agent: "explore the repo and fill in the verify-app skill"), then sync']),
        `run ${config.bin} doctor, then ${config.bin} gate`,
      ];
      return {
        ok: sync.ok,
        summary: `initialised ${created.length} seed file(s); sync wrote ${sync.written.length} adapter file(s) for ${config.harnesses.length} harness(es)`,
        details: [...created.map((c) => `seeded ${c}`), ...sync.conflicts.map((c) => `conflict ${c} (re-run with --force to overwrite)`), ...nextSteps.map((s) => `next: ${s}`)],
        data: { created, sync },
      };
    },
  },
];
