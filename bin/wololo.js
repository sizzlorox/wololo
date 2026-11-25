#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, cwd: process.cwd(), env: process.env });
process.exitCode = code;
