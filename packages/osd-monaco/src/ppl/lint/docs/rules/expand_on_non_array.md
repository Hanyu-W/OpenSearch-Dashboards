---
rule: expand-on-non-array
---

# expand on a non-array field

**What it detects.** An `expand` command applied to a field whose mapping is
not an array-like type.

**Why it matters.** `expand` flattens array values into separate rows; on a
scalar field it does nothing useful and usually signals a misunderstanding of
the data shape.

**Example.**

```
source=logs | expand status            # scalar field: nothing to expand
source=logs | expand tags              # array field: one row per tag
```

**How to fix it.** Point `expand` at an array field, or remove the command.

**Availability.** Warning severity, enabled by default, all engine versions.
Needs the selected index's field mappings, so it fires only when a dataset is
selected.
