---
name: hill-climb
description: Use when a result is working but not yet good: score it against the rubric and iterate until the score stops improving.
---

# hill-climb

Once there is a loop, you can hill-climb.

1. `wololo score` to get the baseline. Judgment criteria need your honest score: `wololo score --judge intent=0.7 --judge craft=0.5`.
2. Pick the **weakest** criterion it reports. Make one focused improvement.
3. Re-score. Keep the change only if the score went up and verify is still green; otherwise revert it.
4. Stop when two iterations in a row do not improve, or the gate's `minScore` is met with margin.

Be a harsh judge. Inflated judgment scores are tautological tests for quality. If a criterion keeps needing judgment that could be measured, add a `metric` or `command` criterion to `.wololo/rubric.json`.
