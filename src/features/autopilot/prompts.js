// Prompts are thin: they point at skills (the workflow) and hand over the gate output (the facts).

export const VERIFIER_FOCUS = [
  'edge cases and invalid input',
  'error paths and failure handling',
  'state, concurrency and ordering',
  'the user-facing contract (API, CLI or UI) exercised end to end',
  'security and data handling',
];

/**
 * @param {string} bin
 * @param {string} failures
 * @param {{ retry?: boolean, rules?: string[] }} [opts]
 */
export function fixerPrompt(bin, failures, opts = {}) {
  return [
    'You are the fixer in an autopilot loop. The merge gate is red.',
    ...(opts.retry ? ['A previous fix attempt did not change this failure. Re-read the error, question your assumptions and try a different approach.'] : []),
    'Follow the `verify` skill (.wololo/skills/verify/SKILL.md). Fix root causes, not symptoms; never weaken a test, rule or rubric to go green.',
    'If a failure is caused by the environment (missing rule, flaky step, unclear convention), fix the environment and say so in the commit message.',
    `When \`${bin} gate\` passes, commit with a message that explains why, then stop.`,
    ...(opts.rules ?? []),
    '',
    'Gate output:',
    failures,
  ].join('\n');
}

/** @param {string} bin @param {string} focus @param {string} [base]  commit the task started from */
export function verifierPrompt(bin, focus, base) {
  return [
    `You are a verifier agent. Fuzz the current change with a focus on: ${focus}.`,
    // Without a base, "the current change" reads as the latest commit, which is the previous verifier's fix:
    // each verifier then fuzzes that fix deeper and the loop never converges.
    ...(base ? [`The change is the whole task: \`git diff ${base}\` (commits since ${base.slice(0, 12)} plus the working tree), not just the latest commit.`] : []),
    'Follow the `verify` and `tdd` skills. Actually run and use what was built (hands and eyes), do not just read the diff.',
    'A real defect is one a user, the running program or real data can hit. Hand-picked extreme values (1e38, denormals, NaN) fed to internal code are not findings unless such input actually reaches it.',
    'If you find a real defect: write a failing test that proves it, fix it, make the gate green, commit. Each finding is one test plus one fix.',
    `If you find nothing real, change nothing. Do not add tautological tests or cosmetic edits: a changed tree means you found something.`,
    `Gate command: ${bin} gate`,
  ].join('\n');
}

/**
 * @typedef {object} Handoff  What a fresh builder needs to know about the plan it is part of.
 * @property {string} goal
 * @property {string[]} done
 * @property {string[]} next
 * @property {string} [task]
 */

/**
 * @param {string} bin
 * @param {string} goal
 * @param {{ handoff?: Handoff, rules?: string[], resume?: { reason: string, landed: string[], dirty?: string[] }, peers?: Peers }} [opts]
 */
export function builderPrompt(bin, goal, opts = {}) {
  const h = opts.handoff;
  const r = opts.resume;
  return [
    'You are the builder in an autopilot loop.',
    ...(h
      ? [
          '',
          `This is one small step of a larger plan. Overall goal: ${h.goal}`,
          `Already done: ${h.done.length ? h.done.join('; ') : 'nothing yet'}`,
          ...(h.next.length ? [`Later steps (do NOT build them now): ${h.next.join('; ')}`] : []),
          ...(h.task ? [`Your board task is ${h.task}: read its notes with \`${bin} task list --json\` if you are resuming.`] : []),
        ]
      : []),
    '',
    ...(opts.peers ? peerLines(bin, opts.peers) : []),
    'Implement this feature:',
    '',
    goal,
    '',
    ...(r
      ? [
          `The previous builder did not finish (${r.reason}). Continue from where it stopped; do not start over.`,
          r.landed.length ? `It committed: ${r.landed.join('; ')}` : 'It committed nothing.',
          ...(r.dirty?.length ? [`It left these uncommitted (git status): ${r.dirty.join(', ')}`] : []),
          'Check `git status` and `git diff` for uncommitted work it left, keep what is good, and finish the rest. Commit small steps as you go so progress survives if you are cut off too.',
          'Keep your context small: read only the line ranges you need (search first), never whole large files or full command output, and commit as soon as something compiles.',
          '',
        ]
      : []),
    'Follow the `grill` skill to pin down done and how it will be verified (answer from the codebase and `recall`; there is no human to ask), then the `tdd` skill: red, green, refactor. No tautological tests.',
    'Prove it works with the `verify-app` skill: run and use it, do not just read the code.',
    `Done when \`${bin} gate\` passes. Commit with a message that states the intent and how it was verified, then stop.`,
    'Verifier agents will try to break your change next.',
    ...(opts.rules ?? []),
  ].join('\n');
}

/**
 * @param {string} bin
 * @param {string} goal
 * @param {string} planPath
 * @param {{ window?: string, maxTasks: number, rules?: string[], blind?: boolean, size?: string, parallel?: number }} opts
 */
export function plannerPrompt(bin, goal, planPath, opts) {
  return [
    'You are the planner in an autopilot loop. Do not write any code.',
    '',
    'Goal:',
    goal,
    '',
    'Read just enough of the repo to understand it (search, do not read everything), then split the goal into small, ordered steps.',
    ...(opts.window
      ? [
          'Do not browse the web, fetch docs or research now: your context is small. If the goal needs research (a game, an engine, an API), make it the first step(s), each writing short notes to docs/notes/<topic>.md (under 100 lines) that later steps read.',
          'Write the plan file within your first few actions, then refine it only if you have room.',
          ...(opts.rules ?? []),
        ]
      : []),
    ...(opts.blind ? ['Plan from the goal alone: your previous attempt ran out of context or time. Do not open files, browse or run commands; just write the plan file.'] : []),
    `Each step is built later by a fresh agent${opts.window ? ` with a ${opts.window}` : ''} that knows only the goal, the titles of finished steps and its own step. So each step must:`,
    `- be small: ${opts.size ?? 'a few files, one behaviour'}, finishable in one sitting;`,
    '- leave the repo working: the gate passes after every step;',
    '- be verifiable on its own: say exactly how done will be checked (which test or command);',
    '- be ordered so that every step only depends on earlier ones.',
    ...(opts.parallel && opts.parallel > 1
      ? [
          `Up to ${opts.parallel} steps are built at the same time, each by its own agent on its own branch, then merged. So for every step also give:`,
          '- "deps": the numbers (1-based) of the earlier steps it really needs; [] when it needs none. Fewer deps = more runs in parallel.',
          '- "touches": the exact files it will change, test files included (e.g. "src/time/mod.rs", "tests/time.rs", "Cargo.toml"). Not whole dirs. Steps whose touches overlap never run at once; shared files like a manifest or main entry point count.',
          '- If most steps would edit one central file (a main loop, a list of systems), make step 1 turn it into a registry each later step plugs into, and keep that file out of the later steps\' touches.',
        ]
      : []),
    `Use at most ${opts.maxTasks} steps. Prefer fewer when the goal is small.`,
    '',
    `Write the plan to ${planPath} as JSON: {"tasks": [{"title": "imperative, under 80 chars", "body": "what to build, constraints, and how done is verified"${opts.parallel && opts.parallel > 1 ? ', "deps": [1], "touches": ["src/area/"]' : ''}}]}`,
    `Do not create board tasks yourself and do not commit; wololo (${bin}) reads the file.`,
  ].join('\n');
}

/**
 * @param {string} bin
 * @param {string} goal
 * @param {string[]} done  titles of the steps that landed
 * @param {string[]} markers  unfinished-work markers found by `git grep` (file:line: text)
 * @param {string} gapsPath
 * @param {{ window?: string, maxTasks: number, rules?: string[], size?: string }} opts
 */
export function gapReviewPrompt(bin, goal, done, markers, gapsPath, opts) {
  return [
    'You are the gap reviewer in an autopilot loop. Do not write any code.',
    '',
    'Goal:',
    goal,
    '',
    'Steps that landed (each passed the gate):',
    ...done.map((t) => `- ${t}`),
    '',
    ...(markers.length ? ['Unfinished-work markers in the code (TODO, FIXME, stubs):', ...markers.map((m) => `- ${m}`), ''] : []),
    'Compare the goal with what the repo actually does. Find what is missing or only half built: features the goal names that do not exist, stubs and placeholders, markers above, flows that do not work end to end. Run the app or its tests if that tells you more.',
    'Search and sample; do not read everything.',
    ...(opts.window ? [`Your context is small (${opts.window}): look at git log --oneline and targeted searches, and write the findings file early.`, ...(opts.rules ?? [])] : []),
    'Do not repeat a landed step unless it is really broken; then say exactly what is broken.',
    `Each gap becomes a step built by a fresh agent, so make each one small (${opts.size ?? 'a few files, one behaviour'}), verifiable on its own and ordered. At most ${opts.maxTasks}; the most important first.`,
    '',
    `Write your findings to ${gapsPath} as JSON: {"tasks": [{"title": "imperative, under 80 chars", "body": "what is missing, how done is verified"}]}`,
    'If the goal is fully met, write {"tasks": []}.',
    `Do not create board tasks yourself and do not commit; wololo (${bin}) reads the file.`,
  ].join('\n');
}

/**
 * @param {{ goal: string, title: string, body: string, why: string, dirty: string[], failures: string }} step
 * @param {{ window?: string, maxSteps: number, rules?: string[], size?: string }} opts
 */
export function splitterPrompt(step, opts) {
  return [
    'You are the splitter in an autopilot loop. Do not write code and do not use tools: everything you need is below.',
    '',
    `Overall goal: ${step.goal}`,
    '',
    `This step was too big for one agent${opts.window ? ` with a ${opts.window}` : ''}: the builder ${step.why}.`,
    `Step: ${step.title}`,
    ...(step.body ? [step.body] : []),
    '',
    step.dirty.length ? `It left this work uncommitted (git, with sizes): ${step.dirty.join(', ')}` : 'It left no uncommitted work.',
    ...(step.failures ? ['Verification currently fails with:', step.failures] : ['Verification currently passes.']),
    '',
    `Split what is LEFT of this step into 2 to ${opts.maxSteps} smaller steps, in order. Each is built by a fresh agent that sees only the goal, the titles of finished steps and its own step, so each must:`,
    `- be ${opts.size ?? 'at most 2 or 3 files and one behaviour (types first, then one system at a time, then wiring)'};`,
    '- leave the repo working: the gate passes after every step;',
    '- say in its body which files it touches and how done is verified.',
    'If the uncommitted work does not build, the first step is to make it build and commit it (fix or trim it, do not extend it; revert what cannot be fixed quickly).',
    ...(opts.rules ?? []),
    '',
    'Reply with only the JSON, no other text: {"tasks": [{"title": "imperative, under 80 chars", "body": "files, behaviour, how done is verified"}]}',
    'Keep it short: think briefly, then answer.',
  ].join('\n');
}

/**
 * @typedef {object} Peers  the other steps being built at the same time
 * @property {string} task        this step's board id
 * @property {string[]} touches   the files and dirs this step owns
 * @property {{ id: string, title: string, touches: string[] }[]} others
 */

/** @param {string} bin @param {Peers} p */
function peerLines(bin, p) {
  return [
    '',
    'You are one of several agents building this plan at the same time, each on its own git branch in its own worktree. Your work is merged into the main branch when your gate passes.',
    p.touches.length ? `Your step owns: ${p.touches.join(', ')}. Stay inside it where you can.` : 'Keep your changes to the files this step needs.',
    ...(p.others.length ? ['Being built right now by other agents (do not change their files):', ...p.others.map((o) => `- ${o.title} (${o.id}): ${o.touches.join(', ') || 'files not declared'}`)] : []),
    `When you change something another step may use (a type, a function signature, a shared file), say so: \`${bin} task note ${p.task} "<what changed>"\`. Messages from the other agents may appear after your tool calls; act on the ones that affect you.`,
    '',
  ];
}

/**
 * A step's branch no longer merges cleanly into the main branch, or the merged result fails the gate.
 * @param {string} bin
 * @param {{ title: string, main: string, conflicts: string[], failures?: string, landed: string[] }} m
 */
export function mergerPrompt(bin, m) {
  return [
    'You are the merger in a parallel autopilot run.',
    '',
    `This worktree holds the branch for the step "${m.title}". Other steps landed on ${m.main} since it started${m.landed.length ? `: ${m.landed.join('; ')}` : ''}.`,
    ...(m.conflicts.length
      ? [
          `\`git merge ${m.main}\` was started here and stopped on conflicts in: ${m.conflicts.join(', ')}.`,
          'Resolve every conflict so that BOTH sides keep working: the other steps already landed and passed their gate, and this step must still do what it set out to do. Do not drop either side to make it compile.',
          'Then `git add` the files and `git commit --no-edit` to finish the merge.',
        ]
      : [`The branch merges, but the merged result fails the gate. \`git merge ${m.main}\` has been done here; fix the code so both this step and the landed steps work.`]),
    ...(m.failures ? ['', 'Gate output:', m.failures, ''] : []),
    `Done when \`${bin} gate\` passes in this worktree and everything is committed. Do not start new features.`,
  ].join('\n');
}
