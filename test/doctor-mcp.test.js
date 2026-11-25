import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpProblems } from '../src/features/doctor/mcp.js';

test('an MCP server whose command is a URL is flagged, with the http entry to use instead', () => {
  const config = { mcpServers: {
    pixellab: { command: 'https://api.pixellab.ai/mcp', args: ['-t', 'http', '-H', 'Authorization: Bearer pixl_secret'] },
    wololo: { command: 'npx', args: ['wololo', 'mcp'] },
    remote: { type: 'http', url: 'https://example.com/mcp' },
  } };
  const problems = mcpProblems('.mcp.json', config);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\.mcp\.json: "pixellab" has a URL as its command/);
  assert.match(problems[0], /"type":"http","url":"https:\/\/api\.pixellab\.ai\/mcp"/);
  assert.match(problems[0], /"headers":\{"Authorization":"Bearer \$\{PIXELLAB_API_KEY\}"\}/, 'moves the secret to an env var');
  assert.doesNotMatch(problems[0], /pixl_secret/, 'never echoes the key');
});

test('VS Code style "servers" are checked too, and a clean config has no problems', () => {
  assert.equal(mcpProblems('.vscode/mcp.json', { servers: { x: { command: 'http://localhost:3000/mcp' } } }).length, 1);
  assert.deepEqual(mcpProblems('.mcp.json', { mcpServers: { a: { command: 'node', args: ['s.js'] } } }), []);
  assert.deepEqual(mcpProblems('.mcp.json', {}), []);
});
