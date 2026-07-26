---
rule: division-by-zero
---

# Division by literal zero

**What it detects.** A division whose divisor is the literal `0`.

**Why it matters.** The engine evaluates division by zero to `null` rather
than raising an error, so downstream filters and aggregations silently skip
those rows — the query "works" but the numbers are wrong.

**Example.**

```
source=logs | eval rate = errors / 0             # every rate is null
source=logs | eval rate = errors / total         # guard total instead
```

**How to fix it.** Remove the zero divisor, or guard it:
`eval rate = if(total = 0, 0, errors / total)`.

**Availability.** Warning severity, enabled by default, all engine versions,
no data-source connection required.
