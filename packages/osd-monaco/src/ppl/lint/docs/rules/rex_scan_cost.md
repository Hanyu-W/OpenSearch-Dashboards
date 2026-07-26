---
rule: rex-scan-cost
---

# Pattern extraction over a large text field can be expensive

**What it detects.** A `rex` or `parse` over a large text field (for example a
raw log body) with no filter narrowing the rows first.

**Why it matters.** Pattern extraction runs per row on the raw text; over
millions of unfiltered rows it dominates query time. Note that `rex`/`parse`
preserve rows (non-matching rows keep the pipeline with null extractions), so
the linter's hint suggests a leading-literal prefilter only when one can be
derived from the pattern itself.

**Example.**

```
source=logs | rex field=body "user=(?<user>\\w+)"                          # full scan
source=logs | where match(body, "user=") | rex field=body "user=(?<user>\\w+)"
```

**How to fix it.** Filter the rows before extracting — by time range, an
indexed field, or the literal prefix of the pattern. No automatic quick fix is
offered because a `where` prefilter changes which rows survive the pipeline;
the hover hint explains the trade-off instead.

**Availability.** Info severity, **off by default** — an administrator enables
it per cluster in Advanced Settings (`query:enhancements:pplLint:rules`). All
engine versions. Needs the selected index's field mappings to judge field
size, so it fires only when a dataset is selected.
