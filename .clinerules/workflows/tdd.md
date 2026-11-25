<!-- Use when implementing a feature or fixing a bug. Red, green, refactor; tests that can fail. -->
# tdd

TDD: **red → green → refactor**.

1. **Red.** Write the smallest test for the next behaviour. Run it and watch it fail for the right reason. A test you never saw fail is unproven.
2. **Green.** Write the least code that passes. No speculative generality.
3. **Refactor.** Clean up with the test as a safety net, then `wololo verify --fast`.

## No tautological tests

A tautological test cannot fail: `expect(true).toBe(true)`, asserting a mock returns what you told it to, asserting `x == x`, or no assertion at all. The `tautological-tests` rule catches the obvious ones; you are responsible for the subtle ones. Ask: *if I broke the code, would this test go red?*

For bugs: first write the test that reproduces the bug report, then fix.
