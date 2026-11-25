import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine } from '../src/features/autopilot/activity.js';
import { meter, summarize } from '../src/features/autopilot/usage.js';

const line = (/** @type {any} */ e) => JSON.stringify(e);

test('omp and claude streams report per-turn usage; claude result totals win over the turns', () => {
  const omp = parseLine(line({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 200, cost: { input: 0.003, cacheRead: 0.0027, total: 0.01 } } } }));
  assert.deepEqual(omp.usage, { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 200, cost: 0.01, inputCost: 0.003, cacheReadCost: 0.0027 });

  const m = meter();
  m.add(/** @type {any} */ (parseLine(line({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 1 } } }))).usage);
  // claude repeats a message's usage once per content block: same id counts once
  m.add(/** @type {any} */ (parseLine(line({ type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', name: 'Read', input: {} }], usage: { input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 40 } } }))).usage);
  m.add(/** @type {any} */ (parseLine(line({ type: 'assistant', message: { id: 'b', content: [], usage: { input_tokens: 20, cache_read_input_tokens: 6000, cache_creation_input_tokens: 100, output_tokens: 30 } } }))).usage);
  let s = m.summary();
  assert.equal(s.turns, 2);
  assert.deepEqual(s.contexts, [5010, 6120], 'prompt size per turn: everything sent, cached or not');
  assert.equal(s.output, 70);
  m.add(/** @type {any} */ (parseLine(line({ type: 'result', result: 'done', total_cost_usd: 0.42, usage: { input_tokens: 31, output_tokens: 72, cache_read_input_tokens: 11000, cache_creation_input_tokens: 100 } }))).usage);
  s = m.summary();
  assert.equal(s.cost, 0.42);
  assert.equal(s.cacheRead, 11000, 'the result line is the authoritative total');
  assert.equal(s.turns, 2, 'the result line is not a turn');
});

test('summarize: totals, per role, prompt-size median, cache hit rate and what the cache saved', () => {
  const runs = [
    { type: 'agent', role: 'builder', ts: '2026-11-25T00:00:00Z', promptChars: 4000, turns: 2, input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0, cost: 0.05, saved: 0.02, contexts: [4000, 6000] },
    { type: 'agent', role: 'verifier (edge cases)', ts: '2026-11-25T01:00:00Z', promptChars: 1000, turns: 1, input: 2000, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contexts: [2000] },
    { type: 'gate', ok: true },
  ];
  const s = summarize(/** @type {any} */ (runs));
  assert.equal(s.runs, 2);
  assert.equal(s.total.input, 3000);
  assert.equal(s.total.cacheRead, 9000);
  assert.equal(s.hitRate, 0.75, 'cache read / (input + cache read + cache write)');
  assert.equal(s.medianContext, 4000, 'median of every turn across runs');
  assert.equal(s.maxContext, 6000);
  assert.equal(s.medianPromptChars, 2500);
  assert.equal(s.total.saved, 0.02);
  assert.deepEqual(s.roles.map((r) => [r.role, r.runs]), [['builder', 1], ['verifier', 1]], 'verifier focuses fold into one role');
  assert.equal(summarize([]).runs, 0);
});
