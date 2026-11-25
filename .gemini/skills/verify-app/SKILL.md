---
name: verify-app
description: Use when you must prove a wololo change works end to end. Drives the real CLI, hooks and MCP server in a scratch repo. Keep it current.
---

# verify-app

wololo is a CLI, an MCP server and a hook entrypoint. Prove changes by using them the way a harness does.

## Start it

No server. Work in a scratch repo: `git init` a temp dir with a `package.json`, then `node <repo>/bin/wololo.js init --bin "node <repo>/bin/wololo.js"`.

## Use it

- CLI: run the command you changed, with and without `--json`; check the exit code.
- Hooks: pipe a harness payload into `wololo hook <harness> <event>`, e.g. `{"tool_input":{"file_path":"x.test.js"}}` for `claude post-edit`. Expect exit 2 plus stderr on a violation.
- MCP: send `initialize` then `tools/list` / `tools/call` as JSON lines to `wololo mcp` (see `test/mcp.test.js`).
- Adapters: `wololo sync` then read the generated file for the harness you touched; `wololo sync --check` must be clean afterwards.

## Look at it

Events: `.wololo/state/events.jsonl`. Board, queue, reviews: `.wololo/state/`. Generated-file hashes: `.wololo/generated.json`.

## Golden paths

1. `init` in an empty repo wires all harnesses and `sync --check` is clean.
2. A tautological test triggers `check` (exit 1) and the `post-edit` hook (exit 2).
3. `gate` exits 0 on a clean repo and 1 when a rule, verify or adapters fail.
4. `mcp` lists every non-CLI-only command as a `wololo_*` tool.
5. Interactive `init` in a real terminal (a pty) asks its questions on stderr and writes the answers into `verify-app` (`test/init.test.js` scripts the answers).
6. `autopilot --task <id>` with `autopilot.command` pointed at a fake agent: builder runs first, the task ends done (or blocked on human when the gate never goes green); see `test/autopilot.test.js`.
7. `autopilot --goal "…" --plan` with a fake planner: tasks land in order with fresh builders; a stuck task stops the plan and `--group` resumes it; repeated failures and verifier ping-pong stop early; see `test/autopilot-plan.test.js`.
8. A streaming agent (omp `--mode json` events) shows its tool calls in the autopilot terminal, and `watch --once`, run mid-run, shows the plan, the agent, context use and the activity feed; the live TUI runs in a pty and quits on `q`. See `test/watch.test.js`.

`test/cli.test.js`, `test/init.test.js`, `test/autopilot.test.js`, `test/autopilot-plan.test.js` and `test/watch.test.js` automate these; when you add a golden path, add it there too.
