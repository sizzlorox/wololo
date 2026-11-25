<!-- Use when outside context arrives (bug reports, Slack, Linear, email, review findings) or the queue grows. Buffer, cluster, then act on patterns. -->
# triage

Not every trigger should spawn a fix right away.

1. `wololo queue pull` imports from configured sources; `wololo queue add` for anything else. Capture, do not act yet.
2. `wololo queue patterns` clusters open items.
3. Decide per cluster: one task group (`wololo task add --group …`), an environment fix, or drop with a reason (`wololo queue resolve <id> --drop --note "…"`).
4. Act on singletons only when urgent.
