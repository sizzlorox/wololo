# Principles

The bible for this repo. Every change to wololo, and every agent working on it, is judged against these. When a feature, rule or skill conflicts with them, the principles win, or we change them on purpose.

Credit: Lauren Tan's principles for working with coding agents.

## Mindset

- Domain expertise matters more than ever. The bottleneck is no longer the agent but how clearly you can express your intent and goals.
- Language matters. Short, loaded words like "TDD", "tautological" and "grilling" pack a lot of intent, and agents pick them up and reuse them in their reasoning.
- Treat building agent output like a Michelin kitchen, not a factory: aim for quality and craft, not just volume. As the human, you're the head chef or tech lead. You no longer write the code, but you're still responsible for the outcome and your name is on it.
- The trust ladder: the more you trust your agents, the more you can hand off and the more agents you can run. You earn that trust through tooling, not hope.
- Sharpen your knives. With dull tools you end up micromanaging and never get time to improve your setup. The engineer's new job is mostly building the environment the agents work in.

## Verification

- Verification is the most important skill in your toolkit. Give agents "hands and eyes" so they can run, use and debug what they built.
- Verification is what turns agent work into a loop. Without it, you're the "meat proxy" between the agent and the result.
- Once there's a loop, you can hill-climb: score the result against a rubric and let agents keep improving it.
- Each app should have its own verification skill, and agents should keep it up to date.
- Agents take shortcuts, so make the easy thing the right thing.

## Determinism vs judgment

- Put the mechanical parts in scripts or CLIs and leave only the judgment calls to the agent.
- Give agents shared tools so they stop rebuilding the same thing every time, each one differently.
- A skill can be a thin wrapper of instructions around deterministic tools.
- Do migrations with codemods and AST transforms, not agent rewrites.
- Audit your skills and rules for parts that could be deterministic.

## Environment and constraints

- A good codebase is one that's easy to change without breaking things.
- Constrain the space, the way TypeScript narrows a type: there should be only one way to do each thing. Use conventions (feature folders, registries) and strict lint rules so bad code is hard to write.
- Avoid god files by breaking them into small, separate pieces.
- Watch how agents fail. Each repeated mistake should become a lint rule or constraint, not a correction to that one agent.
- Put rules in the environment, not in the agent's instructions, so agents run into them at the moment they matter.
- A good environment helps human new hires as well as agents.

## Scaling (outer and inner loops)

- The inner loop is agents working toward a snapshot of your intent. The outer loop brings in outside context (Slack, Linear, X, email, bug reports). Connect the two loops so agents gather their own context instead of you relaying it.
- Keep asking where you're the bottleneck, and teach the agent to answer that question itself from real data, not guesses.
- Context, not control (borrowed from Netflix management): make agents self-sufficient instead of micromanaging them.
- Use coordinator or chief-of-staff agents that delegate and supervise without doing the work themselves. Group related tasks under one coordinator so agents don't duplicate work and someone sees the bigger picture.
- Run multiple "restaurants", meaning parallel projects, and move between them as needed.
- Not every trigger should spawn a fix right away. Sometimes buffer findings in a queue or document, then look for patterns.
- Much of the volume is gardening: steady cleanup and keeping the codebase healthy.
- Work backward from the question "how can my agent merge its own code?"

## Review and merging

- Sample instead of blocking: you can't taste every dish, but you should never stop tasting entirely. Review rigorously when you sample, and fix the environment, not the individual agent.
- A one-off mistake can be ignored. A repeated one means the environment needs fixing.
- Autopilot means verifier agents fuzz each PR, fix what they find and loop until it can land. Tune how many verifiers to cost.
- Review after merge by reading the commit history, and revert or add constraints when needed.
- Verification plus a good environment is what makes it safe to step away. Code and environment still matter: garbage in, garbage out. This is not vibe coding.
- How far you can automate depends on how verifiable your domain is. Strong verification can turn one-way doors into two-way doors. Formal proofs and agent-oriented languages may extend this to domains that are harder to verify.

## Skills

- A skill is just a process written down in words. Nothing magical.
- Everyone should carry their own knives: build your own skill set and freely mix pieces from others.
- Past transcripts are a goldmine because they show your real process. Mine them for the places you had to step in.
- Turn workflows you repeat into skills, like recall for pulling context from earlier chats.
- With current models, skills should describe workflows, not implementation details, and will keep getting smaller.
- Measure what each skill actually changes, so you're not flying blind.
