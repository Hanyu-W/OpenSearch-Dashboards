---
rule: wildcard-source-zero-match
---

# Wildcard source pattern matches no index

**What it detects.** A wildcard in the `source=` clause (for example
`source=logs-*`) that matches none of the indices visible to you.

**Why it matters.** The query runs but returns nothing, which is easy to
misread as "no matching documents" when the real problem is the index pattern.

**Example.**

```
source=lgos-*        # typo: matches no index
source=logs-*        # matches logs-2026.07.25, logs-2026.07.26, ...
```

**How to fix it.** Correct the pattern so it matches at least one existing
index. When one visible index is a close match, the quick fix suggests the most
likely one for you to review.

**Availability.** Info severity, enabled by default, all engine versions.
Needs the list of visible indices, so it fires only when a data source is
connected.
