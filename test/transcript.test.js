// wololo-ignore-file no-secrets: fake tokens on purpose, to test the secret detector
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDir } from '../src/core/files.js';
import { statePath } from '../src/core/state.js';
import { entriesOf, importLastRun, listRuns, readRun, recorder, secrets } from '../src/features/autopilot/transcript.js';

const ev = (/** @type {any} */ e) => e;

test('omp events become transcript entries: what was sent, the thinking, the reply, tool calls and the results sent back', () => {
  assert.deepEqual(entriesOf(ev({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'You are the builder' }] } })), [{ kind: 'sent', text: 'You are the builder' }]);
  assert.deepEqual(
    entriesOf(ev({ type: 'message_end', message: { role: 'assistant', provider: 'local-gpu', model: 'nemotron', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] } })),
    [{ kind: 'thinking', text: 'hmm' }, { kind: 'reply', text: 'ok' }, { kind: 'call', tool: 'bash', text: '{"command":"ls"}' }],
  );
  assert.deepEqual(entriesOf(ev({ type: 'message_end', message: { role: 'toolResult', toolName: 'read', isError: true, content: [{ type: 'text', text: 'no such file' }] } })), [{ kind: 'result', tool: 'read', text: 'no such file', error: true }]);
  assert.deepEqual(entriesOf(ev({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Le' } })), [{ kind: 'delta', of: 'thinking', text: 'Le' }]);
  assert.deepEqual(entriesOf(ev({ type: 'message_start', message: { role: 'assistant', provider: 'local-gpu', api: 'openai-completions', model: 'nemotron', content: [] } })), [{ kind: 'endpoint', text: 'local-gpu · openai-completions · nemotron' }]);
});

test('claude events too: thinking, text, tool_use, and tool_result blocks', () => {
  assert.deepEqual(
    entriesOf(ev({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a' } }] } })),
    [{ kind: 'thinking', text: 'plan' }, { kind: 'call', tool: 'Read', text: '{"file_path":"a"}' }],
  );
  assert.deepEqual(entriesOf(ev({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'body' }], is_error: false }] } })), [{ kind: 'result', text: 'body', error: false }]);
});

test('a recorder writes one run file as it goes, with the prompt first; the echo of the prompt is not stored twice', () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-transcript-'));
  const rec = recorder(root, 'builder', 'You are the builder');
  rec.add({ kind: 'sent', text: 'You are the builder' });
  rec.add({ kind: 'thinking', text: 'think' });
  rec.add({ kind: 'delta', of: 'reply', text: 'x' });
  const run = readRun(root, rec.id);
  assert.deepEqual(run.map((e) => e.kind), ['prompt', 'thinking'], 'deltas are live-only, the echo is skipped');
  assert.equal(listRuns(root)[0].role, 'builder');
  assert.equal(rec.live(), 'x');
  rec.add({ kind: 'reply', text: 'x done' });
  assert.equal(rec.live(), '', 'a finished block clears the live text');
  rec.add({ kind: 'delta', of: 'thinking', text: 'Let me' });
  rec.add({ kind: 'delta', of: 'thinking', text: ' look' });
  assert.equal(rec.live(), 'Let me look');
});

test('secrets: bearer tokens, API keys and private keys in what was sent are flagged', () => {
  const found = secrets("claude mcp add x -H 'Authorization: Bearer pixl_0000fake0000fake0000fake0000fake' and sk-ant-api03-abcdefghijklmnopqrstuv and AKIAABCDEFGHIJKLMNOP\n-----BEGIN RSA PRIVATE KEY-----");
  assert.deepEqual(found.map((f) => f.kind), ['bearer token', 'API key', 'AWS key', 'private key']);
  assert.match(found[0].preview, /^pixl_00…/, 'previews never repeat the whole secret');
  assert.deepEqual(secrets('just some code: const token = getToken();'), []);
  assert.deepEqual(secrets('password = "hunter2hunter2"').map((f) => f.kind), ['password']);
});

test('the last run before transcripts existed is imported from agent-stream.log, named from autopilot.log', () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-transcript-'));
  ensureDir(statePath(root));
  writeFileSync(statePath(root, 'autopilot.log'), '\n===== 2026-11-24T18:37:15.842Z verifier (edge cases): omp =====\nstuff\n');
  writeFileSync(statePath(root, 'agent-stream.log'), [JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'You are a verifier' }] } }), JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }), 'not json'].join('\n'));
  assert.equal(importLastRun(root), true);
  const [run] = listRuns(root);
  assert.equal(run.role, 'verifier (edge cases) · imported');
  assert.deepEqual(readRun(root, run.id).map((e) => e.kind), ['prompt', 'reply']);
  assert.equal(importLastRun(root), false, 'only once');
});

test('listRuns reads only the head of each run file: the TUI lists them every frame, and live runs grow to megabytes', async () => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const root = mkdtempSync(join(tmpdir(), 'wololo-transcript-'));
  const rec = recorder(root, 'builder', 'You are the builder');
  for (let i = 0; i < 50; i++) rec.add({ kind: 'result', tool: 'bash', text: 'x'.repeat(20000) });
  const orig = fs.default.readFileSync;
  let read = 0;
  fs.default.readFileSync = /** @type {any} */ ((/** @type {any[]} */ ...a) => {
    const out = orig(.../** @type {[any]} */ (a));
    read += out.length;
    return out;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(listRuns(root).map((r) => r.role), ['builder']);
  } finally {
    fs.default.readFileSync = orig;
    syncBuiltinESMExports();
  }
  assert.ok(read < 100_000, `read ${read} bytes to list one run`);
});

test('a live run is parsed as it grows: only the new bytes are read, and a half-written line counts once it is finished', async () => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { transcriptScreen } = await import('../src/features/tui/screens/transcript.js');
  const root = mkdtempSync(join(tmpdir(), 'wololo-transcript-'));
  const rec = recorder(root, 'builder', 'You are the builder');
  for (let i = 0; i < 50; i++) rec.add({ kind: 'result', tool: 'bash', text: 'x'.repeat(20000) });
  const ctx = /** @type {any} */ ({ root });
  const ui = {};
  const kinds = () => transcriptScreen.load(ctx, ui).data.entries.map((/** @type {any} */ e) => e.kind);
  assert.equal(kinds().length, 51);

  const file = statePath(root, 'runs', `${rec.id}.jsonl`);
  const line = JSON.stringify({ kind: 'reply', text: 'done' });
  fs.appendFileSync(file, line.slice(0, 10)); // the agent is mid-write
  const origFile = fs.default.readFileSync;
  const origSync = fs.default.readSync;
  let read = 0;
  fs.default.readFileSync = /** @type {any} */ ((/** @type {any[]} */ ...a) => {
    const out = origFile(.../** @type {[any]} */ (a));
    read += out.length;
    return out;
  });
  fs.default.readSync = /** @type {any} */ ((/** @type {any[]} */ ...a) => {
    const n = origSync(.../** @type {[any, any]} */ (a));
    read += n;
    return n;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(kinds().length, 51, 'the partial line waits');
    fs.appendFileSync(file, `${line.slice(10)}\n`);
    assert.deepEqual(kinds().slice(-2), ['result', 'reply'], 'finished: parsed once');
    assert.equal(kinds().length, 52);
  } finally {
    fs.default.readFileSync = origFile;
    fs.default.readSync = origSync;
    syncBuiltinESMExports();
  }
  assert.ok(read < 100_000, `read ${read} bytes for a few new lines`);
});

test('the transcript pane is virtual: scrolling a long run reads only the entries on screen, and shows the right ones', async () => {
  const { transcriptScreen } = await import('../src/features/tui/screens/transcript.js');
  const { painter } = await import('../src/features/watch/widgets.js');
  let reads = 0;
  const entries = Array.from({ length: 3000 }, (_, i) => ({
    kind: 'reply',
    get text() {
      reads++;
      return `reply ${i}`;
    },
  }));
  const d = { runs: [{ id: 'r', role: 'builder', at: '' }], run: { id: 'r', role: 'builder', at: '' }, data: { end: 0, entries, found: [] }, agent: null, live: new Map(), liveId: undefined };
  const ui = /** @type {any} */ ({ at: 0, scroll: 0, follow: false });
  const show = () => transcriptScreen.render(d, ui, 150, 40, painter(false)).join('\n');
  show();
  reads = 0;
  ui.scroll = 6 + 3 * 1000; // a 6-line header, then 3 lines per reply: label, text, blank
  const screen = show();
  assert.match(screen, /reply 1000\b/);
  assert.doesNotMatch(screen, /reply 999\b/);
  assert.ok(reads < 200, `read ${reads} entries to show one screen`);
  ui.follow = true;
  assert.match(show(), /reply 2999\b/, 'follow shows the end');
});

test('tool calls read like what the agent did: the command on its own lines, short arguments beside the tool', async () => {
  const { entryLines } = await import('../src/features/tui/screens/transcript.js');
  const { painter } = await import('../src/features/watch/widgets.js');
  const c = painter(false);
  const call = (/** @type {string} */ tool, /** @type {any} */ args) => entryLines({ kind: 'call', tool, text: typeof args === 'string' ? args : JSON.stringify(args) }, {}, c);
  const bash = call('bash', { command: "cat > x.mts <<'EOF'\nimport { S } from './s.js';\nEOF", cwd: 'D:/w', timeout: 60 });
  assert.match(bash[0], /← bash .*cwd D:\/w .*timeout 60/);
  assert.deepEqual(bash.slice(1, 4), ["  $ cat > x.mts <<'EOF'", "    import { S } from './s.js';", '    EOF'], 'real lines, not \n');
  assert.match(call('read', { path: 'src/a.ts', offset: 10 })[0], /← read .*path src\/a\.ts .*offset 10/);
  const write = call('write', { path: 'a.txt', content: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') });
  assert.ok(write.includes('  content'), 'a long text argument gets its own block');
  assert.ok(write.some((l) => /more lines \(o\)/.test(l)), 'cut like a tool result');
  assert.deepEqual(call('odd', 'not json').slice(1, 2), ['  not json'], 'unparsable arguments are shown as they are');
});
