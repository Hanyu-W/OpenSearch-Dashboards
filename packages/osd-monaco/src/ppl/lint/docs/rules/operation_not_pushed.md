---
rule: operation-not-pushed
---

# Operation not pushed down to the index

**What it detects.** A pipeline step that the engine's query planner could not
push down to the OpenSearch index, based on the query's actual `_explain`
plan.

**Why it matters.** Steps that are not pushed down run in the coordinator over
every intermediate row instead of using the index, which is the most common
cause of slow PPL queries on large data.

**Example.**

```
source=logs | where age - 2 > 30       # arithmetic on the field side blocks pushdown
source=logs | where age > 32           # pushes down to the index
```

**How to fix it.** Simplify the highlighted expression — most often by moving
arithmetic from the field side of a comparison to the literal side. For the
integer additive case a quick fix performs that inversion automatically (it is
only offered when the rewrite is exact).

**Availability.** Warning severity, **off by default** — an administrator
enables it per cluster in Advanced Settings
(`query:enhancements:pplLint:rules`). Engine 3.3.0 or later with the Calcite
engine, and requires `_explain` access to the data source.
