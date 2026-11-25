import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../src/core/args.js';
import { globToRegExp, matchAny } from '../src/core/glob.js';
import { findTautologies } from '../src/features/check/tautology.js';
import { parseMessages, interventions } from '../src/features/transcripts/parse.js';

test('argument parser supports negation, arrays, numbers and positionals', () => {
  const parsed = parseArgs(
    ['--no-fast', '--tag', 'one,two', '--max=3', 'task'],
    {
      fast: { type: 'boolean', description: 'fast' },
      tag: { type: 'string[]', description: 'tags' },
      max: { type: 'number', description: 'max' },
    },
    [{ name: 'name', description: 'name', required: true }],
  );
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.values, { fast: false, tag: ['one', 'two'], max: 3, name: 'task' });
});

test('glob conversion supports recursive and brace patterns', () => {
  assert.equal(globToRegExp('src/**/*.{js,ts}').test('src/feature/main.ts'), true);
  assert.equal(matchAny('src/feature/main.ts', ['test/**', 'src/**/*.ts']), true);
  assert.equal(matchAny('src/feature/main.py', 'src/**/*.ts'), false);
});

test('tautology detector catches literal and same-sided assertions', () => {
  // wololo-ignore tautological-tests: fixture string for the detector itself
  assert.equal(findTautologies("test('literal', () => expect(true).toBe(true));").length > 0, true);
  assert.equal(findTautologies('test("real", () => expect(add(1, 2)).toBe(3));').length, 0);
});

test('transcript parser extracts messages and identifies human corrections', () => {
  const messages = parseMessages(
    [
      JSON.stringify({ type: 'user', message: { content: 'Please add a test' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will add one.' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'No, run it and prove it fails first.' } }),
    ].join('\n'),
  );
  assert.equal(messages.length, 3);
  assert.equal(interventions({ file: 'session.jsonl', harness: 'test', mtime: 1, raw: '', messages }).length, 1);
});

test('npm .cmd shims on Windows resolve to interpreter + script so agents spawn without a shell', async () => {
  const { fromCmdShim } = await import('../src/core/exec.js');
  const shim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\bun.exe" (',
    '  SET "_prog=%dp0%\\bun.exe"',
    ') ELSE (',
    '  SET "_prog=bun"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*',
  ].join('\r\n');
  assert.deepEqual(fromCmdShim(shim, 'C:\\npm\\omp.cmd', () => false), ['bun', 'C:\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js']);
  assert.deepEqual(fromCmdShim(shim, 'C:\\npm\\omp.cmd', (p) => p === 'C:\\npm\\bun.exe'), ['C:\\npm\\bun.exe', 'C:\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js']);
  assert.equal(fromCmdShim('@echo off\r\nsomething.exe %*', 'C:\\x.cmd', () => false), null, 'unknown shims are not guessed at');
});
