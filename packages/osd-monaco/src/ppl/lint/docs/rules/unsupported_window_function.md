---
rule: unsupported-window-function-in-eventstats
---

# Unsupported window function in eventstats/streamstats

**What it detects.** A window or aggregation function inside `eventstats` or
`streamstats` that the engine does not support in that position.

**Why it matters.** `eventstats` and `streamstats` accept only a fixed set of
aggregation functions. Anything else fails at execution time with an engine
error.

**Example.**

```
source=logs | eventstats row_number() as rank            # unsupported here
source=logs | eventstats avg(latency) as avg_latency     # supported
```

**How to fix it.** Use one of the supported aggregation functions, or compute
the value with a different command (for example `sort` plus `head` for
top-N-style questions).

**Availability.** Error severity, enabled by default, engine 3.4.0 or later,
no data-source connection required.
