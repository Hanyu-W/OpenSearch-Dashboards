---
rule: head-without-sort
---

# head without a preceding sort

**What it detects.** A `head` command with no `sort` earlier in the pipeline.

**Why it matters.** Without a sort, the engine returns whichever N rows arrive
first; results can change between runs of the same query.

**Example.**

```
source=logs | head 10                            # nondeterministic
source=logs | sort - @timestamp | head 10        # deterministic
```

**How to fix it.** Add a `sort` before `head`. No automatic quick fix is
offered because the right sort key depends on your data.

**Availability.** Info severity, enabled by default, all engine versions, no
data-source connection required.
