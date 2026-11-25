<!-- Use for routine codebase health work between features: small cleanups, drift, stale skills, near-god files, leftover TODOs. -->
# garden

Much of the volume is gardening: steady, small, safe cleanup.

1. `wololo garden` lists chores, ranked. `--enqueue` buffers them in the queue instead of acting.
2. Take **one** chore. Keep the change small and behaviour-preserving; prefer a codemod for anything repetitive.
3. `wololo gate`, then merge.

If a chore keeps reappearing, the environment is producing it: use `fix-the-environment`.
