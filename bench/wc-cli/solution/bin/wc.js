#!/usr/bin/env node
const MODES = { '--lines': 'lines', '--chars': 'chars' };
const flag = process.argv[2];
if (flag !== undefined && !(flag in MODES)) {
  process.stderr.write('usage: wc [--lines | --chars] < input\n');
  process.exit(2);
}
const mode = flag ? MODES[flag] : 'words';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const count = {
    words: () => input.split(/\s+/).filter(Boolean).length,
    lines: () => (input === '' ? 0 : input.replace(/\n$/, '').split('\n').length),
    chars: () => [...input].length,
  }[mode]();
  process.stdout.write(`${count}\n`);
});
