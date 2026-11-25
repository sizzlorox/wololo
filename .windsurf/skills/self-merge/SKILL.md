---
name: self-merge
description: Use when a change is ready to land and you are trusted to merge your own code. Work backward from: how can I merge this myself, safely?
---

# self-merge

Self-merge is earned through verification, not hope.

1. Check the trust level: `wololo trust`. Below the level that allows self-merge, open a PR and stop.
2. `wololo gate`. It checks generated adapters are in sync, rules, verify and the rubric. Fix until it exits 0. Never weaken the gate.
3. For riskier changes, `wololo autopilot` runs verifier agents that fuzz the change, fix what they find and loop until the gate is green.
4. Merge with a commit message that states intent and how it was verified. Post-merge sampling (`review-sample`) keeps everyone honest.

One-way doors (data migrations, public API, deletes) need a rollback path or a human, regardless of trust.
