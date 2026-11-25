<!-- Use when adding or editing skills, or periodically: find parts of skills that should be deterministic tools, and measure what each skill changes. -->
# skill-audit

A skill is a process written in words. Mechanical parts belong in scripts.

1. `wololo skills audit` flags shell-heavy steps, bulk rewrites, bloat and vague descriptions.
2. For each finding, move the mechanics into a script, a `wololo` command, or a codemod, and leave only the judgment in the skill.
3. `wololo skills stats` shows usage and outcomes per skill. A skill that changes nothing should be deleted.
4. After large skill or rule changes, `wololo bench run` checks the whole harness still beats no harness on tasks with hidden tests.

Skills should describe workflows, not implementation details, and keep getting smaller.
