---
name: recall
description: Use at the start of a task or when stuck, to pull context from earlier agent sessions on this project instead of asking the human again.
---

# recall

Past transcripts hold decisions, dead ends and corrections.

- `wololo recall "<topic or error text>"` searches past Claude Code, Codex, Copilot and Gemini sessions for this project and returns the most relevant snippets.
- Prefer recalled decisions over re-deciding. If a past session was corrected by the human, follow the correction.
- If recall shows the same correction more than once, that is an environment gap: use `fix-the-environment`.
