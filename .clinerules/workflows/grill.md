<!-- Use before starting any non-trivial task, or when intent is ambiguous. Grill the request until done and verification are unambiguous. -->
# grill

The bottleneck is how clearly intent is expressed. Grill it before you build.

## Ask (yourself first, the human only if you cannot answer from context)

- What exactly is the outcome? What is explicitly out of scope?
- How will we **verify** it: which test, which command, which screen?
- What does the existing codebase already do for this? Is there a registered way? (`wololo recall "<topic>"`, read the feature folder.)
- What could go wrong: edge cases, migrations, one-way doors?

Gather your own context before asking: past sessions (`wololo recall`), the queue, the board, the code. Ask the human only what the data cannot answer, in one batch.

## Output

A short brief at the top of your task note (`wololo task note`): goal, non-goals, verification plan, risks. Then build.
