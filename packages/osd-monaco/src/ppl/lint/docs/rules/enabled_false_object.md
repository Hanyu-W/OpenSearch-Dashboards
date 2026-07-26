---
rule: enabled-false-object
---

# Field inside an enabled:false object

**What it detects.** A reference to a field nested inside an object mapped
with `enabled: false`.

**Why it matters.** Fields under an `enabled: false` object are stored but not
indexed, so in queries they resolve to `null`: filters on them match nothing
and aggregations return `null`, all without an error.

**Example.**

```
source=logs | where metadata.trace_id = "abc"    # metadata is enabled:false
```

**How to fix it.** Query a field outside the disabled object, or change the
mapping (and reindex) if the field genuinely needs to be searchable.

**Availability.** Warning severity, enabled by default, all engine versions.
Needs the selected index's field mappings, so it fires only when a dataset is
selected.
