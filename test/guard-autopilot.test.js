import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, prompts, repo, scratch, tasks, wololo } from './helpers/autopilot-fixture.js';

// The v-sim-v2 failure, end to end: the brief says art comes from an MCP server the agent never had.

test('a goal that needs an MCP server nobody configured stops before any agent runs', () => {
  writeFileSync(join(repo, 'BRIEF.md'), 'All sprites come from the `pixellab` MCP server.\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'brief']);
  const r = wololo(['autopilot', '--goal', 'Read BRIEF.md and add alpha', '--json']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(JSON.parse(r.out).summary, /not started: the goal needs the pixellab MCP server, but claude does not have it for this project\. Add it to \.mcp\.json or ~\/\.claude\.json/);
  assert.deepEqual(prompts(), [], 'no agent spent anything');
});

test('a step that should use a tool but never calls it is blocked, not landed', () => {
  const mcp = JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8'));
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ ...mcp, mcpServers: { ...mcp.mcpServers, pixellab: { command: 'pixellab-mcp' } } }, null, 2) + '\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'mcp']);
  const r = wololo(['autopilot', '--goal', 'Add alpha using the pixellab MCP', '--json']);
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /depends on pixellab, but no agent called it/);
  assert.ok(existsSync(join(repo, 'alpha.js')), 'the builder did write a stand-in');
});

test('a step the planner says needs a tool is blocked when the tool is missing; the others still land', () => {
  // the fixture's agent, with a planner that names a tool for beta
  const agent = readFileSync(join(scratch, 'agent.cjs'), 'utf8').replace("{ title: 'Add beta', body: 'beta.js exports beta' }", "{ title: 'Add beta', body: 'beta.js exports beta', tools: ['figma'] }");
  writeFileSync(join(scratch, 'agent.cjs'), agent);
  const r = wololo(['autopilot', '--goal', 'Add alpha and beta', '--plan', '--json']);
  assert.notEqual(r.code, 0);
  assert.deepEqual(tasks('done').map((/** @type {any} */ t) => t.title), ['Add alpha']);
  const blocked = tasks('blocked');
  assert.equal(blocked[0].title, 'Add beta');
  assert.match(blocked[0].blockedWhy, /needs the figma MCP server/);
  assert.ok(!existsSync(join(repo, 'beta.js')), 'no builder ran for it');
});

test('n in the TUI checks the goal before launching it, and says why it did not start', async () => {
  const { act } = await import('../src/features/watch/actions.js');
  const { loadConfig } = await import('../src/core/config.js');
  writeFileSync(join(repo, 'BRIEF.md'), 'Art comes from the `pixellab` MCP server.\n');
  /** @type {string[][]} */
  const launched = [];
  const ctx = /** @type {any} */ ({ root: repo, config: loadConfig(repo), launch: (/** @type {string[]} */ a) => launched.push(a) });
  const v = /** @type {any} */ ({ alive: false, tasks: [], status: null });
  const msg = await act('n', v, ctx, 'Read BRIEF.md and finish it');
  assert.match(msg, /^not started: the goal needs the pixellab MCP server/);
  assert.deepEqual(launched, [], 'nothing was launched to stop in the background');
  assert.match(await act('n', v, ctx, 'Add alpha'), /^started: Add alpha/);
  assert.equal(launched.length, 1);
});
