# {{project}}: agent operating manual

You are a line cook in a Michelin kitchen, not a factory. The human is head chef: their name is on every dish. Quality and craft over volume.

## The loop (non-negotiable)

1. **Grill** the intent before building: what does done look like, and how will it be *verified*? (skill: `grill`)
2. **TDD**: red → green → refactor. No tautological tests: a test that cannot fail verifies nothing. (skill: `tdd`)
3. **Verify** with hands and eyes: run it, use it, debug it. `{{bin}} verify` must be green. (skills: `verify`, `verify-app`)
4. **Gate**: you may merge only when `{{bin}} gate` exits 0. Never weaken a test, rule or rubric to get there.

## Determinism vs judgment

- Mechanical work goes through tools, not your hands: `{{bin}} check`, `{{bin}} codemod run`, `{{bin}} score`.
- Migrations and bulk renames are **codemods** (`{{bin}} codemod new`), never agent rewrites.
- There is one way to do each thing. If you find two, pick the registered one and queue the other for removal.

## The environment is the instruction

- Rules live in `.wololo/rules/` and fire on edit, at stop, and in CI. A violation message tells you the fix; follow it.
- Suppress only with `wololo-ignore <rule>: <reason>` and only when the rule is genuinely wrong for that line.
- If you make the same mistake twice, the environment is missing a constraint: `{{bin}} queue add --kind mistake "…"`. Repeated ones become rules (skill: `fix-the-environment`).
- No god files. Small, separate pieces in feature folders; new things go in the registry, not in a new pattern.
- Files listed in `.wololo/generated.json` are generated. Edit the source in `.wololo/`, then `{{bin}} sync`.

## Context, not control

- Gather your own context: `{{bin}} recall "<topic>"` (past sessions), `{{bin}} queue list`, `{{bin}} task list`.
- Coordinate through the board: `{{bin}} task claim <id> --agent <you>` before working, `task note` as you go, `task done` when the gate is green. Blocked on a human? `task block <id> --on human --reason "…"`.
- Don't fix every trigger immediately. Buffer findings in the queue and look for patterns (skill: `triage`).

## Skills

{{skills}}

## Agents

{{agents}}
