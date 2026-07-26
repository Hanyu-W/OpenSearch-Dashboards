---
rule: field-validation
---

# Reference to an unknown field

**What it detects.** A field name in the query that does not exist in the
selected index's mappings, plus Splunk-style `field=` syntax that PPL does not
use.

**Why it matters.** Unknown fields typically fail at execution time, or worse,
silently match nothing — for example a typo in a `where` clause returns zero
rows without an error.

**Example.**

```
source=logs | where staus = "error"          # typo: unknown field
source=logs | where status = "error"         # valid
```

**How to fix it.** Correct the field name. Two quick fixes are offered: when
the name is close to a real field, "Replace with" suggests the closest match
("Did you mean...?"); when Splunk-style `field=` syntax is detected, a rewrite
to the PPL form is offered.

**Availability.** Error severity, enabled by default, all engine versions.
Needs the selected index's field mappings, so it fires only when a dataset is
selected.
