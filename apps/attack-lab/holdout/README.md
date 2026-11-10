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

**D and HD are the current holdout.** HB5's result led to a rule change: a claim of approval only the AI saw, from a
payee the owner really pays, now holds and doesn't block. So B, HB, C and HC are no longer blind. The rules were frozen
again at commit `753cf87`, and these were written after it, aimed at that change. To check, this should list nothing:

```bash
git diff --stat 753cf87 HEAD -- packages/core/src/detectors packages/core/src/decision.ts packages/core/src/config.ts packages/core/src/policy.ts packages/core/src/checker.ts
```

**E and HE are the current holdout.** Three rules were added after seeing the results above: a bill lower than the amount
asked, a payee's 24-hour total, and little history or a first-time asset. So B, HB, C, HC, D and HD are no longer blind. The
rules were frozen again at commit `ecf7936`, and E and HE were written after it, aimed at getting around those rules. To
check, this should list nothing:

```bash
git diff --stat ecf7936 HEAD -- packages/core/src/detectors packages/core/src/decision.ts packages/core/src/config.ts packages/core/src/policy.ts packages/core/src/checker.ts
```

**All 5 of the E attacks took money,** by staying just inside the numbers. We stopped tuning here on purpose: the next
threshold could be dodged the same way.

**So that diff now lists `decision.ts`, for wording only.** On 2026-11-06 an ALLOW to a payee the owner already pays
began leading its reasons with that fact, instead of with a small note. It came from a real mainnet payment whose ALLOW
began "This account has never been funded", not from a holdout result. No decision, score or rule changed: in the
results, the only difference is the first reason on two ALLOWs.

**And `detectors/duplicate.ts`, for one real rule change.** On 2026-11-10 Shurik asked for it after testing the hosted
server as an agent: an API that charges the same price for every call had its second call within 15 minutes held, even
with a new invoice id. Now two payments that each carry their own, different invoice id aren't treated as the same
payment, unless what the agent read says the first one failed. A payment with no invoice id, after one with none, or
with the same id, is still held. It came from using the product, not from a holdout result, and every result in
[`../results/latest.md`](../results/latest.md) stayed byte for byte the same. Still, E and HE were written before it, so
they're no longer strictly blind to the rules as they are now.
