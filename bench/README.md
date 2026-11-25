# Bench suite

Tasks for `wololo bench`, which measures what the harness changes: the same agent gets the same prompt on the same starting code, with and without wololo installed, and hidden acceptance tests decide who passed.

Each folder is one task:

- `task.json`: `prompt` (the request, as you would give it to an agent), `check` (runs the hidden tests), optional `setup` and `timeoutMin`.
- `repo/`: the starting code. The agent only ever sees this.
- `hidden/`: acceptance tests, copied to `hidden/` in the workspace after the agent stops.
- `solution/`: a reference solution overlaid on `repo/` by `wololo bench validate`.

`wololo bench validate` must pass: every hidden check fails on the starting code and passes with the solution. A task that cannot fail measures nothing.

Good tasks look like your real work and hide the edge cases a careful, test-driven agent would find and a hasty one would miss. Add tasks from your own repo with `wololo bench new <name>`.
