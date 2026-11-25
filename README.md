# wololo

A harness for AI coding agents: verification loops, rules enforced at edit time, a merge gate, a task board, and autopilot that builds whole projects, serially or with parallel agents. Run it all from one terminal UI.

Built on [PRINCIPLES.md](PRINCIPLES.md), the bible for this repo.

Works with Claude Code, Codex, Copilot, Cursor, Gemini CLI, Windsurf, opencode, Amp, Aider, Cline and oh-my-pi (`omp`), including local models. Node ≥ 20, git. No runtime dependencies.

## Install

Not on npm yet (the npm package `wololo` is unrelated). Install it globally from GitHub:

```sh
npm i -g github:sizzlorox/wololo        # install; run it again to update
wololo                                  # in any repo: the TUI
```

`init` sets `bin` to `wololo`, which agents and hooks use to call it. In CI, add the install to `ci.setup` in `wololo.config.json`: `"run: npm i -g github:sizzlorox/wololo"`.

Avoid `npx github:…`: npx caches GitHub packages and keeps running the first version it downloaded.

## New project

```sh
mkdir my-app && cd my-app && git init
wololo init                             # pick your agents
git add -A && git commit -m wololo
wololo                                  # press n, type the goal
```

The first planned step scaffolds a verifiable project. Its test commands become the verify steps.

## Existing project

```sh
cd my-app
wololo init                             # detects test/lint/start commands, asks for the rest
wololo doctor
git add -A && git commit -m wololo
```

Then use the TUI: run the gate on **Health**, add work on **Board**, press `n` on **Autopilot**. After editing `.wololo/`, run `wololo sync`.

## TUI

`wololo` opens it. Runs continue in the background after `q`. Switch tabs with `1`–`9`, `0` or `tab`; `?` lists every key on the current tab.

| Tab | What |
|---|---|
| Autopilot | Live run: plan, agents, workers, merge queue, agent messages. `r` retry/resume · `s` skip · `a` add step · `m` agent/model · `n` new goal · `x` stop |
| Transcript | Everything sent to and from the model per run, live, with the endpoint and secret warnings |
| Board | Tasks: add, edit, move, block, release, delete, build |
| Queue | Findings: add, resolve, turn into tasks, cluster |
| Review | Commits autopilot sampled for you to taste, with diffs. `o` ok · `e` fix the environment · `v` revert. Verdicts move the trust ladder |
| Learned | Skills wololo learned from repeated agent work, their trigger and trial result. `p` keep · `x` retire · `d` delete |
| Health | gate, verify, check, score, doctor, garden, with drill-down |
| Usage | Tokens per run and role, prompt size, cache hits, cost |
| Config | Every setting, validated on save |
| Commands | Every command, run from a form |

## Autopilot

`n` (or `wololo autopilot --goal "…" --plan`):

1. A planner splits the goal into small steps.
2. Fresh agents build each step: builder, then fixers until the gate is green, then verifiers.
3. A gap reviewer adds whatever is still missing.

A step that passes also gets hill-climbed (`autopilot.hillClimb`, 1 round by default) against `.wololo/rubric.json`: a judge scores it, an improver works on the weakest criterion, and the change stays only if the gate is green and the score went up.

After each step lands, a share of its commits is sampled for you to review (the Review tab), at the trust ladder's rate. Reviews never block the run.

It stops when stuck and blocks that step; press `r` to retry or `s` to skip. Resume with `r` after any stop or crash.

Headless agents run with full permissions (e.g. Claude `bypassPermissions`). Use autopilot only on code and machines you're willing to let an agent change.

**Parallel:** set `autopilot.workers` > 1.
- Steps that don't touch the same files build at once, each in its own git worktree.
- Branches merge one at a time through the gate. A merger agent resolves conflicts.
- Agents share notes after each tool call and are warned before editing another step's files.

## Learned skills

After each step lands, wololo compares the agent runs so far. When agents keep repeating the same sequence of tool calls (3+ runs across 2+ steps), one agent writes it down as a small script or a short skill, with a trigger: which files and roles it applies to.

- Only agents whose step and role match get it, in their prompt. Nobody else pays for it in context.
- It starts on trial. It is kept if those agents then need fewer turns, and retired if they don't, or if it never matches.
- Claude Code users can also call one by hand (`/learned-<id>`); Claude doesn't see it otherwise.
- Stored in `.wololo/learned/`, committed with the repo. `autopilot.learn`: `auto` (default), `suggest` (only queue what it noticed) or `off`.

## Local models

Set `autopilot.contextWindow` to your server's context size. Steps, prompts, tools and thinking level shrink to fit, and stuck agents (circling, stalled, compaction loops) are killed and resumed.

## Privacy

The Transcript tab shows what is sent: prompts, tool results (including file contents), and the endpoint. Possible secrets are flagged. Keep keys out of goals and task text: the goal goes into every builder prompt.

## Config

`wololo.config.json`, also editable on the Config tab:

| `autopilot.` | Default | |
|---|---|---|
| `agent` | first picked | Agent CLI that builds |
| `models` | – | Model per agent, e.g. `{"claude": "sonnet", "omp": "local-gpu/nemotron-super"}`. `m` changes it mid-run |
| `workers` | 1 | Steps built at once |
| `learn` | auto | Learned skills: `auto`, `suggest` or `off` |
| `hillClimb` | 1 | Rubric hill-climb rounds per step (0 = off) |
| `contextWindow` | – | Model context in tokens |
| `maxIterations` | 5 | Fix/verify rounds per step |
| `verifiers` | 1 | Verifier passes per green gate |
| `gapRounds` | 3 | Gap reviews after a plan lands |
| `agentTimeoutMinutes` / `stallMinutes` | 45 / 20 | Kill limits |

Other keys: `verify.steps`, `gate.minScore`, `harnesses`, `mcp.tools`, `sources`. See `schema/wololo.config.schema.json`.

## Commands

`wololo help` lists them; `--json` gives machine output. Most are also MCP tools (`wololo_<command>`).

## Development

```sh
npm install
node bin/wololo.js gate
```

`src/core` shared code (child processes via `proc.js`) · `src/features/<name>` one feature per folder · `src/adapters/<agent>.js` one per agent.

## License

MIT
