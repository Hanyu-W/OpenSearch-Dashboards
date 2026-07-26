---
rule: multisearch-min-subsearch
---

# multisearch requires at least two subsearches

**What it detects.** A `multisearch` command with fewer than two subsearches.

**Why it matters.** `multisearch` interleaves results from multiple
subsearches; the engine requires at least two and rejects the query otherwise.

**Example.**

```
| multisearch [ source=logs-a ]                              # only one
| multisearch [ source=logs-a ] [ source=logs-b ]            # valid
```

**How to fix it.** Add a second subsearch, or replace the command with a plain
search over the single source.

**Availability.** Error severity, enabled by default, engine 3.4.0 or later.
Fires only with a connected data source (the command is not part of the
bundled grammar).
