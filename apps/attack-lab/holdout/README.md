# Holdout scenarios

The main scenarios were written alongside the rules, so passing them shows the rules work as designed, not that they
stop what they haven't seen. These were written afterwards, to be realistic rather than to pass.

**The rules were frozen at commit `2bb78b8` before the B and HB cases were written.** Nothing in the detectors, scoring
or decision rules was changed until the one change below.

If a rule is ever changed because of a result here, these cases stop being a holdout, and this file has to say so.

**That happened once.** The unusual amount check (D6) was added on 2026-11-03, after these B results had been seen, so
that diff now lists it. It came from a competitor review, and none of the B results changed. Even so, B cases are no
longer blind.

**C and HC are the new holdout.** The rules were frozen again at commit `9a0bce6`, and these were written after it, aimed
at getting around the new check. Nothing was tuned after their first run. To check that, this should list nothing:

```bash
git diff --stat 9a0bce6 HEAD -- packages/core/src/detectors packages/core/src/decision.ts packages/core/src/config.ts packages/core/src/policy.ts packages/core/src/checker.ts
```

Results are in the "Holdout" section of [`../results/latest.md`](../results/latest.md). They're measured, not expected:
a miss here is a finding to report, not a failed build. The author wrote both the rules and these attacks, so this is
weak evidence compared with attacks from someone else. It's still better than none, and the misses are real.
