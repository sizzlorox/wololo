---
name: review-sample
description: Use when doing post-merge review: sample merged commits, taste them rigorously, and fix the environment for anything wrong.
---

# review-sample

Sample instead of blocking. You cannot taste every dish, but never stop tasting.

1. `wololo review sample` picks commits at the trust ladder's rate (never zero). `wololo review list` shows what is waiting.
2. Review each one **rigorously**: does it do what was intended, was it truly verified, would you sign it?
3. Record: `wololo review record <sha> ok`, `fix-env --note "…"` (the environment let this through), or `revert --note "…"` (and revert it).
4. Non-ok verdicts are queued as mistakes. Repeated ones become rules via `fix-the-environment`.
