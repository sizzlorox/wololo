<!-- Use periodically (weekly) or when improving skills: mine past agent sessions for places the human had to step in, and turn them into skills or rules. -->
# mine-transcripts

Past transcripts show your real process. Interventions are the gold.

1. `wololo transcripts mine` lists sessions with human interventions (corrections, interrupts) and clusters them.
2. For each cluster, decide: is it a missing **constraint** (→ `fix-the-environment`), a repeated **workflow** (→ `wololo skills new`), or missing **context** (→ AGENTS.md / verify-app)?
3. Measure afterwards: `wololo skills stats` and the next mining run should show fewer interventions of that kind.
