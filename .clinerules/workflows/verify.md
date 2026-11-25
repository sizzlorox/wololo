<!-- Use before claiming any change is done, and whenever you need to know if the code works. Runs the project's verification loop and interprets failures. -->
# verify

Verification turns your work into a loop. Without it the human becomes the meat proxy between you and the result.

## Steps

1. Run `wololo verify` (add `--fast` while iterating). It runs every configured step and reports the tail of the first failure.
2. Read the failure. Fix the **cause**, not the symptom; never weaken a test, skip it, or loosen a rule to go green.
3. For anything user-facing, also follow the `verify-app` skill: actually run and use what you built.
4. Repeat until green, then `wololo gate`.

## Judgment calls

- A green suite that never exercised your change is not verification. Add the test that would have caught the bug.
- If verification is slow, flaky or missing a step, that is an environment bug: `wololo queue add --kind env "…"`.

## Done when

`wololo gate` exits 0 and you have seen the change work with your own hands and eyes.
