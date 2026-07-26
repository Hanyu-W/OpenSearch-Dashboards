---
rule: operation-pushed-as-script
---

# Operation pushed down as a script

**What it detects.** A pipeline step that the engine pushed down only as a
script query — evaluated per document on the data nodes — based on the query's
actual `_explain` plan.

**Why it matters.** Script-based evaluation is much slower than a native index
query. The query is correct, but on large indices this step can dominate
runtime.

**Example.**

```
source=logs | where age - 2 > 30       # pushed as a per-document script
source=logs | where age > 32           # native range query
```

**How to fix it.** Simplify the highlighted expression so it maps to a native
query — typically by moving arithmetic to the literal side of the comparison.
For the integer additive case a quick fix performs that inversion
automatically (it is only offered when the rewrite is exact).

**Availability.** Info severity, **off by default** — an administrator enables
it per cluster in Advanced Settings (`query:enhancements:pplLint:rules`).
Engine 3.3.0 or later with the Calcite engine, and requires `_explain` access
to the data source.
