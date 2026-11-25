import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { defaultConfig } from '../src/core/config.js';
import { runSync } from '../src/features/sync/command.js';
import { testRule } from '../src/features/check/rules.js';
import { walk } from '../src/core/files.js';
import { templatePath } from '../src/core/templates.js';

test('seed rules have examples that continue to match their declared files', () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-rules-'));
  try {
    const source = templatePath('rules');
    mkdirSync(join(root, '.wololo', 'rules'), { recursive: true });
    for (const file of walk(source, source)) {
      const rule = JSON.parse(readFileSync(join(source, file), 'utf8'));
      assert.deepEqual(testRule(rule), [], rule.id);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync is idempotent and reports hand-edited generated files as conflicts', () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-sync-'));
  try {
    const source = templatePath('skills');
    mkdirSync(join(root, '.wololo', 'skills'), { recursive: true });
    for (const skillDir of ['verify', 'verify-app']) {
      const from = join(source, skillDir, 'SKILL.md');
      const dest = join(root, '.wololo', 'skills', skillDir, 'SKILL.md');
      mkdirSync(join(root, '.wololo', 'skills', skillDir), { recursive: true });
      writeFileSync(dest, readFileSync(from));
    }
    const config = defaultConfig(root);
    config.harnesses = ['claude', 'codex'];
    config.ci.provider = 'none';
    const ctx = { cwd: root, root, config, hasConfig: true, env: {}, readStdin: async () => '' };

    const first = runSync(ctx, {});
    assert.equal(first.ok, true);
    assert.ok(first.written.length > 0);
    const second = runSync(ctx, { check: true });
    assert.equal(second.ok, true);
    assert.deepEqual(second.drift, []);

    const agents = join(root, 'AGENTS.md');
    writeFileSync(agents, `${readFileSync(agents, 'utf8')}\nhuman notes outside the managed block\n`);
    assert.equal(runSync(ctx, { check: true }).ok, true, 'text outside managed blocks is the human\'s');

    const owned = join(root, '.claude', 'skills', 'verify', 'SKILL.md');
    writeFileSync(owned, `${readFileSync(owned, 'utf8')}\nhand edit\n`);
    const conflict = runSync(ctx, { check: true });
    assert.equal(conflict.ok, false);
    assert.ok(conflict.conflicts.includes('.claude/skills/verify/SKILL.md'));
    assert.equal(runSync(ctx, { force: true }).ok, true);
    assert.ok(!readFileSync(owned, 'utf8').includes('hand edit'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('omp adapter wires MCP, skills, agents and a hook module that feeds wololo back to the model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-omp-'));
  try {
    mkdirSync(join(root, '.wololo', 'skills', 'verify'), { recursive: true });
    writeFileSync(join(root, '.wololo', 'skills', 'verify', 'SKILL.md'), readFileSync(join(templatePath('skills'), 'verify', 'SKILL.md')));
    mkdirSync(join(root, '.wololo', 'agents'), { recursive: true });
    writeFileSync(join(root, '.wololo', 'agents', 'verifier.md'), readFileSync(join(templatePath('agents'), 'verifier.md')));
    const config = defaultConfig(root);
    config.harnesses = ['omp'];
    config.ci.provider = 'none';
    // A fake wololo: post-edit rejects, stop rejects, both via exit 2 + stderr like the real hook.
    writeFileSync(join(root, 'fake.sh'), '#!/bin/sh\ncat > "$(dirname "$0")/payload-$3.json"\necho "nope from $3" >&2\nexit 2\n', { mode: 0o755 });
    config.bin = `sh ${join(root, 'fake.sh')}`;
    const ctx = { cwd: root, root, config, hasConfig: true, env: {}, readStdin: async () => '' };
    assert.equal(runSync(ctx, {}).ok, true);

    assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.wololo.command, 'sh');
    assert.ok(readFileSync(join(root, '.omp', 'skills', 'verify', 'SKILL.md'), 'utf8').includes('verify'));
    assert.ok(readFileSync(join(root, '.omp', 'agents', 'verifier.md'), 'utf8').includes('name: verifier'));

    const hookSrc = readFileSync(join(root, '.omp', 'hooks', 'post', 'wololo.ts'), 'utf8');
    writeFileSync(join(root, 'hook.mjs'), hookSrc);
    const mod = await import(pathToFileURL(join(root, 'hook.mjs')).href);
    /** @type {Record<string, Function>} */
    const handlers = {};
    /** @type {any[]} */
    const sent = [];
    mod.default({ on: (/** @type {string} */ e, /** @type {Function} */ h) => (handlers[e] = h), sendMessage: (/** @type {any} */ m, /** @type {any} */ o) => sent.push([m, o]) });

    const hctx = { cwd: root };
    assert.equal(await handlers.tool_result({ toolName: 'read', input: { path: 'a.js' } }, hctx), undefined, 'reads are not checked');
    const edit = await handlers.tool_result({ toolName: 'edit', input: { path: 'a.js' } }, hctx);
    assert.match(edit.additionalContext, /nope from post-edit/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'payload-post-edit.json'), 'utf8')).tool_input, { path: 'a.js' });

    for (let i = 0; i < 5; i++) await handlers.agent_end({}, hctx);
    assert.equal(sent.length, 3, 'stop feedback re-triggers the agent at most 3 times in a row');
    assert.match(sent[0][0].content, /nope from stop/);
    assert.equal(sent[0][1].triggerTurn, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('omp headless trims its own tools, LSP and skills when the context window is small', async () => {
  const { ADAPTERS } = await import('../src/adapters/index.js');
  const omp = ADAPTERS.omp;
  const big = /** @type {NonNullable<typeof omp.headless>} */ (omp.headless)('do it', {});
  assert.ok(!big.includes('--tools'), 'large windows keep the full toolset');
  const small = /** @type {NonNullable<typeof omp.headless>} */ (omp.headless)('do it', { contextWindow: 32768 });
  assert.deepEqual(small.slice(0, 3), ['omp', '-p', 'do it']);
  assert.equal(small[small.indexOf('--tools') + 1], 'read,edit,write,bash,grep,glob');
  assert.ok(small.includes('--no-lsp'));
  assert.equal(small[small.indexOf('--skills') + 1], 'verify,verify-app,tdd');
});
