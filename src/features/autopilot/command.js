import { onPath } from '../../core/exec.js';
import { gitOut } from '../../core/git.js';
import { launch } from '../watch/actions.js';

import { readTask } from '../board/store.js';
import { checkMcpFiles } from '../doctor/mcp.js';
import { goalText, mcpMentions, missingServers } from '../guard/tools.js';
import { cpSync, existsSync } from 'node:fs';
import { templatePath } from '../../core/templates.js';
import { wololoPath } from '../../core/state.js';
import { runGate } from '../gate/command.js';
import { judgedScores } from './climb.js';
import { agentArgv } from './argv.js';
import { DEFAULT_STALL_MINUTES } from './agent.js';
import { contextRules, windowLabel } from './budget.js';
import { gateFailures, log, runLoop } from './loop.js';
import { count, setStatus, startStatus } from './status.js';
import { VERSION } from '../../core/version.js';
import { plan } from './plan.js';
import { runWorker } from './worker.js';
import { tasteSample } from './taste.js';
import { clean } from '../clean/clean.js';
import { ensureBranch, rememberBranch, repoBases } from './branch.js';
import { buildGroup } from './review.js';
import { builderPrompt, fixerPrompt, plannerPrompt, VERIFIER_FOCUS, verifierPrompt } from './prompts.js';

export { agentArgv };

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'autopilot',
    summary: 'Build hands-off, then loop until it can land: fixer turns the gate green, verifiers fuzz it. --plan splits a big goal into small tasks for small context windows.',
    mcp: false,
    options: {
      goal: { type: 'string', description: 'Feature to build first (a builder agent implements it, then the loop hardens it)' },
      plan: { type: 'boolean', description: 'With --goal: a planner splits it into small board tasks, built one at a time by fresh agents' },
      group: { type: 'string', description: 'Build (or resume) every open task in this board group, in order' },
      task: { type: 'string', description: 'Board task id to build: claims it, notes progress, marks it done when landed or blocked on human if not' },
      agent: { type: 'string', description: 'Harness to drive headlessly (claude, codex, copilot, cursor, gemini, opencode, amp, aider, omp; default autopilot.agent)' },
      verifiers: { type: 'number', description: 'Verifier passes per green gate (tune to cost)' },
      max: { type: 'number', description: 'Max iterations per task' },
      merge: { type: 'boolean', description: 'Run autopilot.mergeCommand when landed' },
      dryRun: { type: 'boolean', description: 'Show what would run without spawning agents' },
    },
    async run(input, ctx) {
      const { config, root } = ctx;
      const agent = input.agent ?? config.autopilot.agent;
      const verifiers = Math.min(input.verifiers ?? config.autopilot.verifiers, VERIFIER_FOCUS.length);
      const opts = { agent, focuses: VERIFIER_FOCUS.slice(0, verifiers), max: input.max ?? config.autopilot.maxIterations, merge: input.merge };
      const modes = ['goal', 'task', 'group'].filter((m) => input[m]);
      if (modes.length > 1) return { ok: false, summary: `use one of --goal, --task or --group, not ${modes.map((m) => `--${m}`).join(' and ')}`, exitCode: 2 };
      if (input.plan && !input.goal) return { ok: false, summary: '--plan needs --goal', exitCode: 2 };
      const task = input.task ? readTask(root, input.task) : undefined;
      if (input.task && !task) return { ok: false, summary: `no task ${input.task}` };
      const goal = task ? [task.title, task.body].filter(Boolean).join('\n\n') : input.goal;
      const window = config.autopilot.contextWindow;

      if (input.dryRun) {
        const gate = await runGate(ctx, { judge: judgedScores(root) });
        const loop = gate.ok ? opts.focuses.map((f) => agentArgv(config, agent, verifierPrompt(config.bin, f))) : [agentArgv(config, agent, fixerPrompt(config.bin, gateFailures(gate)))];
        const first = input.plan
          ? [agentArgv(config, agent, plannerPrompt(config.bin, goal, '.wololo/state/plan.json', { window: windowLabel(window), maxTasks: 30 }))]
          : goal
            ? [agentArgv(config, agent, builderPrompt(config.bin, goal, { rules: contextRules(window) }))]
            : [];
        const plan = [...first, ...loop];
        const head = input.plan ? 'planner, then a builder per task, a gap review against the goal, then ' : goal ? 'builder, then ' : '';
        return { ok: true, summary: `dry run: ${head}gate ${gate.ok ? 'green → verifiers' : 'red → fixer'} using ${agent}`, details: plan.map((argv) => argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')), data: { gate, plan } };
      }

      const bin = config.autopilot.command?.length ? undefined : agentArgv(config, agent, '')[0];
      if (bin && !onPath(bin)) {
        return { ok: false, summary: `autopilot agent "${agent}" runs \`${bin}\`, which was not found on PATH. Install it, pass --agent <harness>, or set autopilot.agent / autopilot.command in wololo.config.json`, exitCode: 2 };
      }

      // In a terminal: run in the background and open the dashboard, which can retry, skip and stop it.
      if (process.stdout.isTTY && !process.env.WOLOLO_DETACHED) {
        launch(root, process.argv.slice(2));
        await new Promise((r) => setTimeout(r, 500)); // let the run write its status before the first frame
        const { openTui } = await import('../tui/command.js');
        await openTui(ctx, { tab: 'autopilot' });
        return { ok: true, summary: '', stdout: '' };
      }
      if (!process.env.WOLOLO_WORKER) {
        const tidy = clean(root);
        if (tidy.actions.length) log(`housekeeping: freed ${(tidy.freed / 1024 / 1024).toFixed(1)}MB (${tidy.actions.length} action(s); wololo clean --dry-run shows what it does)`);
      }
      if (!process.env.WOLOLO_WORKER) {
        const on = ensureBranch(root, goal ?? input.group ?? 'autopilot', { key: input.group ?? task?.group, patterns: config.autopilot.protectedBranches, bases: repoBases(config) });
        if ('error' in on) return { ok: false, summary: `autopilot never commits to a protected branch, and could not leave this one: ${on.error}`, exitCode: 2 };
        for (const note of on.notes) log(note);
      }
      startStatus(root, { goal, group: input.group, task: task && { id: task.id, title: task.title, started: new Date().toISOString() }, contextWindow: window, agentCli: agent, workers: config.autopilot.workers ?? 1, version: VERSION, stallMinutes: config.autopilot.stallMinutes ?? DEFAULT_STALL_MINUTES });
      log(`watch it live: ${config.bin} watch`);
      for (const problem of checkMcpFiles(ctx.root)) log(`warning: ${problem}`);
      // no rubric means no judge: nobody ever looks at what was built. Start from the default one.
      if (!process.env.WOLOLO_WORKER && !existsSync(wololoPath(root, 'rubric.json'))) {
        cpSync(templatePath('rubric.json'), wololoPath(root, 'rubric.json'));
        log('no .wololo/rubric.json: added the default one, so a judge scores intent, craft and how it looks');
      }
      // the goal's tools before anything is planned: two days of building around a missing image generator is the failure this stops
      const absent = goal && !process.env.WOLOLO_WORKER ? missingServers(mcpMentions(goalText(root, goal)), root, agent) : [];
      if (absent.length) {
        const summary = `the goal needs the ${absent.join(', ')} MCP server${absent.length > 1 ? 's' : ''}, but ${agent} does not have ${absent.length > 1 ? 'them' : 'it'} here (looked in this repo's MCP files and ${agent}'s own settings for this project; a server set up for another CLI or another project does not count). Add ${absent.length > 1 ? 'them' : 'it'} and start again.`;
        setStatus(root, { state: 'stopped', summary, agent: null });
        return { ok: false, summary, exitCode: 2 };
      }
      const r = await (async () => {
        if (input.plan) {
          const planned = await plan(ctx, agent, goal);
          if (!planned.ok) return { ok: false, summary: `planning failed: ${planned.error}` };
          setStatus(root, { group: planned.group });
          rememberBranch(root, planned.group, gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']));
          return buildGroup(ctx, planned.group, opts);
        }
        if (input.group) return buildGroup(ctx, input.group, opts);
        if (process.env.WOLOLO_WORKER && task) return runWorker(ctx, task, opts);
        const single = await runLoop(ctx, { ...opts, goal, task });
        count(root, single.ok ? 'landed' : 'stopped');
        if (single.ok) tasteSample(root, log);
        return single;
      })();
      setStatus(root, { state: r.ok ? 'landed' : 'stopped', summary: r.summary.split('\n')[0], agent: null });
      return r;
    },
  },
];
