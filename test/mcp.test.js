import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { toolFor } from '../src/mcp/server.js';
import { COMMANDS } from '../src/registry.js';

test('MCP tool definitions share command names and schemas', () => {
  const verify = COMMANDS.find((c) => c.name === 'verify');
  assert.ok(verify);
  assert.equal(toolFor(verify).name, 'wololo_verify');
  assert.equal(toolFor(verify).inputSchema.type, 'object');
});

test('MCP stdio initializes and serves the command registry', async () => {
  const child = spawn(process.execPath, ['bin/wololo.js', 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  /** @type {string[]} */
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => lines.push(...chunk.split('\n').filter(Boolean)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);

  const deadline = Date.now() + 3000;
  while (lines.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lines.length >= 2, true);
  const initialized = JSON.parse(lines.find((line) => JSON.parse(line).id === 1) ?? '{}');
  const listed = JSON.parse(lines.find((line) => JSON.parse(line).id === 2) ?? '{}');
  assert.equal(initialized.result.serverInfo.name, 'wololo');
  assert.ok(listed.result.tools.some((/** @type {{ name: string }} */ tool) => tool.name === 'wololo_gate'));
  child.stdin.end();
  await once(child, 'close');
});
