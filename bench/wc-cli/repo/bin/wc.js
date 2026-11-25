#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const words = input.split(/\s+/).filter(Boolean).length;
  process.stdout.write(`${words}\n`);
});
