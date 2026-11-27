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

## Fullstack workspaces (several repos)

Run wololo in a folder that is not a repo but holds repos, e.g. `frontend/` and `backend/`:

```sh
cd work           # contains frontend/ and backend/, each its own git repo
wololo init       # finds each repo's test command
wololo            # one plan, one board, across both
```

- **One plan across repos.** Steps list files by repo (`frontend/src/login.tsx`, `backend/api/auth.ts`); a fullstack step touches both.
- **Branches per repo.** Each repo gets the same work branch (e.g. `feature/add-login`), cut from that repo's base. A repo with more than one integration branch (say `master` and `develop`, used for different things) must set it in `autopilot.repos.<repo>.base`: autopilot never guesses. A repo with just one branches from where it is. Protected branches are never committed to, in any repo.
- **Verify per repo.** Each repo's checks run inside it (`autopilot.repos.<repo>.verify`, or the repo's own `wololo.config.json`) next to the workspace's own; a failure names the repo.
- **Parallel steps** get a folder with a worktree of each repo, laid out like the workspace, plus its `AGENTS.md` and agent config. Merges happen per repo and are all-or-nothing: a step lands in every repo it changed, or in none.
- **Learned skills** about one repo are stored and committed in that repo (`frontend/.wololo/learned/`); ones that span repos stay at workspace level.

The workspace folder's own files (`wololo.config.json`, `.wololo/`, `AGENTS.md`) are not in any repo: keep them in a repo of their own if you want them versioned.

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

**It never commits to `main`, `master`, `develop`, `stage`, `release/*` or similar.** A run started on one of those branches out first: a new branch named the way the repo names branches (`feature/…`, `fix/…`, `perf/…`), or, when resuming a plan, that plan's branch. The same happens on a detached HEAD. Before every commit and merge it checks again, so an agent that switches back to `main` mid-run cannot get its work committed there. Set your own list in `autopilot.protectedBranches`.

Headless agents run with full permissions (e.g. Claude `bypassPermissions`). Use autopilot only on code and machines you're willing to let an agent change.

## Verification grows, never shrinks

Agents take shortcuts to get a green gate. wololo makes the gate stricter on its own as the project grows, and only you can make it weaker.

- **It grows with the project.** When the project gains a test suite, typecheck, build or an app, autopilot adds that check to the gate on its own. Run `wololo verify adopt` to do it yourself. If the project has a check the gate doesn't run, the gate fails (`coverage`).
- **It never shrinks without you (`ratchet`).** wololo locks what the gate rests on: its steps, the scripts and files they run, test-runner configs, the rubric, and how many assertions each test file has. Adding is fine. Removing a step, rewriting it, editing a gate script, deleting a test or thinning its assertions fails the gate until you accept it with `wololo verify approve` (or `a` on the Health tab). Agents can't approve.
- **It opens what was built and looks.** An `app` step runs the thing the way a person would and keeps what it saw:
  - `{"app": {"start": "npx vite --port 5199", "url": "http://localhost:5199/", "expect": "canvas"}}`: a headless Chrome or Edge. Fails on errors, assets that 404, or the element missing or blank.
  - `{"app": {"start": "cargo run", "window": "My Game"}}`: a desktop app or game. Captures its window; fails if it crashes, never opens a window, or the window is blank.
  - `{"app": {"start": "mytool report", "expect": "Total"}}`: a CLI. Its output is the screen; fails on a crash, no output, or missing text.

  wololo detects the app for Vite, Next, Electron, static sites, Rust GUI crates, pygame and Godot. A step about what people see (UI, sprites, rendering…) can't pass until some step opens the app. The judge gets the screenshots under the rubric's `looks` criterion, and they're noted on the task for you.
- **Tools are checked before and after a step.** If the goal or a step names an MCP server ("use the `pixellab` MCP"), autopilot checks the agent it runs actually has it, for this project, before starting. Before landing, it checks the step's transcripts actually called it. A stand-in made some other way is blocked.

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
| `protectedBranches` | main, master, develop, stage, release/*, … | Branches autopilot never commits to; runs started on one branch out |
| `base` | – | Single repo: the branch features start from. Required when it has more than one of main/master/develop |
| `repos` | – | Workspace mode, per repo: `base` (required when ambiguous, as above) and `verify` (its checks) |
| `contextWindow` | – | Model context in tokens |
| `maxIterations` | 5 | Fix/verify rounds per step |
| `verifiers` | 1 | Verifier passes per green gate |
| `gapRounds` | 3 | Gap reviews after a plan lands |
| `agentTimeoutMinutes` / `stallMinutes` | 45 / 20 | Kill limits |

Other keys: `verify.steps`, `gate.minScore`, `harnesses`, `mcp.tools`, `sources`. See `schema/wololo.config.schema.json`.

## Housekeeping

Autopilot tidies `.wololo/state` when it starts: logs over 5MB rotate (`autopilot.log` → `.1` → `.2` → `.3`, oldest dropped), transcripts are capped at the newest 100MB, and stale temp files, unheld locks, finished workers' files and merged worktrees and branches are removed. Unmerged or running work is never touched. Run it yourself with `wololo clean` (`--dry-run` to preview) or `C` on the Health tab.

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
