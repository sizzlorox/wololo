---
name: fix-the-environment
description: Use when an agent (you or another) repeats a mistake, or a review finds a problem. Fix the environment, not the agent: add a rule, constraint, codemod or tool.
---

# fix-the-environment

A one-off mistake can be ignored. A repeated one means the environment needs fixing. Put the rule where the agent will run into it at the moment it matters, not in instructions.

## Pick the strongest fix that fits

1. **Make it impossible**: a type, a registry, a single entry point, a deleted alternative.
2. **Make it loud**: `wololo rule add` with a bad and a good example. It fires on edit, at stop and in CI. Its `fix` text is what the next agent reads.
3. **Make it mechanical**: a script, a `wololo` command, or a codemod so no agent does it by hand.
4. **Last resort**: a line in a skill.

## Steps

1. Confirm it is repeated: `wololo queue patterns` or `wololo recall`.
2. Add the fix. For rules, `wololo rule test` proves the examples hold.
3. Run `wololo check` to see existing violations; fix them or codemod them.
4. Resolve the queue items it absorbs (`wololo queue resolve`).
