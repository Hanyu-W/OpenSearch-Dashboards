---
rule: union-min-datasets
---

# union requires at least two datasets

**What it detects.** A `union` command with fewer than two datasets.

**Why it matters.** `union` combines rows from multiple datasets; with fewer
than two there is nothing to combine and the engine rejects the query.

**Example.**

```
source=logs-a | union                                    # nothing to union
source=logs-a | union [ source=logs-b ]                  # valid
```

**How to fix it.** Add at least one subsearch dataset to the `union`, or
remove the command.

**Availability.** Error severity, enabled by default, engine 3.7.0 or later
with the Calcite engine. Fires only with a connected data source (the command
is not part of the bundled grammar).
