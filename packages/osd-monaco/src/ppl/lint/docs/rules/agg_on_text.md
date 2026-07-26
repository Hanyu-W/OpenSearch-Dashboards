---
rule: agg-on-text
---

# Numeric aggregation on a text field

**What it detects.** A numeric aggregation (`avg`, `sum`, `min`, `max`, ...)
applied to a field mapped as `text`.

**Why it matters.** The engine returns `null` for the aggregation instead of
an error, so the query "succeeds" with a misleading result.

**Example.**

```
source=logs | stats avg(message)              # text field: avg is null
source=logs | stats avg(response_time)        # numeric field
```

**How to fix it.** Aggregate a numeric field, or extract a number from the
text first (for example with `rex`/`parse` and a `cast`).

**Availability.** Warning severity, enabled by default, all engine versions.
Needs the selected index's field mappings, so it fires only when a dataset is
selected.
