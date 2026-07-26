---
rule: replace-wildcard-asymmetry
---

# Asymmetric wildcard counts in replace

**What it detects.** A `replace` command where the pattern and the replacement
contain different numbers of `*` wildcards.

**Why it matters.** Each wildcard in the replacement is filled from the
matching wildcard in the pattern, so the counts must line up. Mismatched
counts fail at execution time.

**Example.**

```
source=logs | replace "*-prod" with "*" in host          # 1 vs 1: fine
source=logs | replace "*-*" with "*" in host             # 2 vs 1: error
```

**How to fix it.** Make the wildcard counts match on both sides of `with`.

**Availability.** Error severity, enabled by default, engine 3.4.0 or later
with the Calcite engine. Fires only with a connected data source (the command
is not part of the bundled grammar).
