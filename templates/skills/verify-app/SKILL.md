---
name: verify-app
description: Use when you must see, run or drive THIS app end to end (UI, API, CLI) to prove a change works. App-specific hands and eyes; keep it current.
---

# verify-app

Each app has its own verification skill. Agents keep it up to date: when a step here is wrong or missing, fix this file in the same change.

## Start it

TODO(wololo): the one command that starts the app locally (and how to know it is ready).

## Use it

TODO(wololo): how to drive it like a user. e.g. Playwright MCP against http://localhost:3000, `curl` against the API, or the CLI with sample input.

## Look at it

TODO(wololo): where logs, screenshots, traces and DB state live, and how to read them.

## Golden paths

TODO(wololo): the 3–5 flows that must always work, each with the observable result that proves it.

## Done when

You exercised every golden path your change touches and saw the expected result, and `wololo verify` is green.
