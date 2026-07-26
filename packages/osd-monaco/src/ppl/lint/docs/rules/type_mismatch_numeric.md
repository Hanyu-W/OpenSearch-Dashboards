---
rule: type-mismatch-numeric
---

# Comparing a numeric field to a non-numeric string

**What it detects.** A comparison between a numeric-mapped field and a string
literal that cannot be parsed as a number.

**Why it matters.** The comparison matches no documents, so the query returns
zero rows without any error — easy to misread as "no matching data".

**Example.**

```
source=logs | where status_code = "error"       # numeric field vs string
source=logs | where status_code >= 500          # valid
```

**How to fix it.** Compare against a number, or use the text field that
actually holds the string value.

**Availability.** Warning severity, enabled by default, all engine versions.
Needs the selected index's field mappings, so it fires only when a dataset is
selected.
