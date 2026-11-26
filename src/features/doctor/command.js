import { existsSync } from 'node:fs';
import { listRepos } from '../../core/repos.js';
import { allSteps } from '../verify/command.js';
import { ADAPTERS } from '../../adapters/index.js';
import { onPath } from '../../core/exec.js';
import { CONFIG_FILE, wololoPath } from '../../core/state.js';
import { loadRules, testRule } from '../check/rules.js';
import { runSync } from '../sync/command.js';
import { loadSkills } from '../sync/sources.js';
import { checkMcpFiles } from './mcp.js';

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'doctor',
    summary: 'Check the kitchen: config, verify steps, rules, skills, adapters, installed agent CLIs.',
    async run(_input, ctx) {
      const { root, config } = ctx;
      /** @type {[boolean, string][]} */
      const checks = [];
      checks.push([ctx.hasConfig, ctx.hasConfig ? `${CONFIG_FILE} found` : `no ${CONFIG_FILE}: run wololo init`]);
      const steps = allSteps(ctx);
      // in a workspace, say how many each repo brings: "backend 1, frontend 2"
      const perRepo = Object.entries(steps.reduce((/** @type {Record<string, number>} */ n, s) => {
        const repo = s.name.includes(': ') ? s.name.split(': ')[0] : '';
        if (repo) n[repo] = (n[repo] ?? 0) + 1;
        return n;
      }, {})).map(([r, n]) => `${r} ${n}`).join(', ');
      checks.push([steps.length > 0, `${steps.length} verify step(s) (${steps.filter((s) => s.fast).length} fast)${perRepo ? `: ${perRepo}` : ''}`]);
      const { rules, errors } = loadRules(root);
      const failing = rules.filter((r) => testRule(r).length);
      checks.push([errors.length === 0 && failing.length === 0, `${rules.length} rule(s)${errors.length ? `, ${errors.length} broken` : ''}${failing.length ? `, ${failing.length} failing their examples` : ''}`]);
      checks.push([existsSync(wololoPath(root, 'rubric.json')), existsSync(wololoPath(root, 'rubric.json')) ? 'rubric present' : 'no rubric: hill-climbing has nothing to climb']);
      const skills = loadSkills(root);
      checks.push([skills.some((s) => s.name === 'verify-app'), `${skills.length} skill(s)${skills.some((s) => s.name === 'verify-app') ? '' : ' — missing verify-app (each app needs its own verification skill)'}`]);
      const sync = runSync(ctx, { check: true });
      checks.push([sync.ok, sync.ok ? 'adapters in sync' : 'adapters drifted: run wololo sync']);
      const agents = config.harnesses.map((h) => ADAPTERS[h]).filter((a) => a?.binary);
      const installed = agents.filter((a) => onPath(/** @type {string} */ (a.binary)));
      checks.push([true, `agent CLIs on PATH: ${installed.map((a) => a.id).join(', ') || 'none'} (autopilot can drive these)`]);
      const mcp = checkMcpFiles(root);
      checks.push([mcp.length === 0, mcp.length ? mcp.join('\n  ') : 'MCP server configs look runnable']);
      const repos = listRepos(root);
      checks.push([repos.length > 0, repos[0] === '.' ? 'git repository' : repos.length ? `workspace of ${repos.length} git repos: ${repos.join(', ')}` : 'not a git repo, and holds no repos: review/autopilot need git']);
      return {
        ok: checks.every(([ok]) => ok),
        summary: checks.every(([ok]) => ok) ? 'kitchen is in order' : `${checks.filter(([ok]) => !ok).length} problem(s)`,
        details: checks.map(([ok, msg]) => `${ok ? '✓' : '✗'} ${msg}`),
      };
    },
  },
];
