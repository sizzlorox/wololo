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
8. A streaming agent (omp `--mode json` events) shows its tool calls in the autopilot terminal, and `watch --once`, run mid-run, shows the plan, the agent, context use and the activity feed. See `test/watch.test.js`.
9. The TUI, driven through a fake terminal (a PassThrough stdin, a stdout that keeps the last frame): every tab renders; board, queue, config and command forms change real state; `m` sets the model; idle frames are not rewritten. See `test/tui.test.js`.
10. The Transcript tab follows a live run: prompt, thinking as it streams, tool calls, results, and secret warnings. The Usage tab counts a run from its first turn, and still after the autopilot process is killed. See `test/tui.test.js`, `test/usage-live.test.js`.
11. Parallel autopilot (`autopilot.workers` > 1): independent steps build at once in worktrees, a dependent one waits for their merge, a conflict goes through a merger agent, a red merged gate is undone and fixed, a dirty main checkout is snapshotted first, and resume works after a crash or a stop mid-merge. See `test/parallel.test.js`.
12. Learned skills: a workflow repeated across steps is written down once, adopted on trial and handed to the next matching agent; `autopilot.learn` off/suggest. See `test/learn-e2e.test.js`.
13. Sample review: a landed step's commits are sampled at the trust rate; the Review tab shows the newest diff and records ok / fix-env (queued as a mistake) / revert. See `test/tui.test.js`.
14. Hill-climb (`autopilot.hillClimb` > 0): a judge scores the rubric, an improver works on the weakest criterion; kept only on a green gate and a higher score, undone otherwise. See `test/climb.test.js`.

Seeing it yourself: open the TUI in a scratch repo (`node <repo>/bin/wololo.js`) with `autopilot.command` pointed at a fake agent script that prints omp-style JSON events (copy one from the tests above). That runs autopilot end to end without sending anything to a model.

The tests named above automate these paths. When you add or change a feature, add its golden path here and to a test in the same change.
