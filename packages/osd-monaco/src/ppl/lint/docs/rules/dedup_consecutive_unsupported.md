---
rule: dedup-consecutive-unsupported
---

# dedup consecutive=true relies on engine fallback

**What it detects.** A `dedup` command with `consecutive=true`.

**Why it matters.** The Calcite engine does not support consecutive dedup, so
the query silently falls back to the legacy engine, which can be slower and
behaves differently on some other commands in the same pipeline.

**Example.**

```
source=logs | dedup consecutive=true host      # triggers fallback
source=logs | dedup host                       # runs on Calcite
```

**How to fix it.** Drop `consecutive=true` if plain deduplication is
acceptable; otherwise be aware the query runs on the legacy engine.

**Availability.** Warning severity, enabled by default, engine 3.3.0 or later
with the Calcite engine, no data-source connection required.
