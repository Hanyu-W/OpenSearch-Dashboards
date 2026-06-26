# PPL lint rule validation (Option 1)

Every lint rule encodes a **claim about engine behavior** — `division-by-zero`
claims "`x / 0` silently returns null", `field-validation` claims "an unknown
field is rejected". Those claims can silently rot when the engine changes (a new
OpenSearch version, Calcite default-on, a bug fix that turns a silent failure
into a loud one). Rule validation is the machinery that keeps each claim honest.

It has three layers, ordered by how much infrastructure they need. The first two
run with no cluster (every PR); the third needs a live engine and is a local-dev
/ pre-release check.

## Layer A — static catalog validator (no cluster)

A jest test asserting the catalog's cross-file invariants. Most already shipped:

- every `detector` key resolves in `detector_registry` (no inert rules) — in
  `catalog.test.ts`;
- every `docUrl` resolves 1:1 with `doc_links.snapshot.json` — in
  `doc_links.test.ts`;
- `appliesTo.minVersion <= OSD_KNOWN_VERSION` — in `catalog.test.ts`.

The **net-new** Layer-A check is the catalog ↔ `PPL_LINT_RULE_DEFAULTS` parity
test, in `src/plugins/query_enhancements/server/__tests__/catalog_defaults_parity.test.ts`.
It lives in `query_enhancements` (not `@osd/monaco`) because `PPL_LINT_RULE_DEFAULTS`
is a `query_enhancements` const and `@osd/monaco` is a leaf package that cannot
depend on it. The test catches the recurring "added a detector + a catalog entry
but forgot the per-rule toggle key" footgun: a rule with no default has no
Advanced-Settings toggle, so it can never be disabled.

## Layer B — in-process behavioral corpus (no cluster)

`__tests__/rule_corpus.ts` + `rule_corpus.test.ts`. For each parse-tree rule, a
table of triggering ("positive") and control ("negative") PPL snippets is run
through `runLint` on **both grammar surfaces** — the compiled simplified parser
and the runtime grammar bundle — asserting the rule fires on positives and stays
silent on controls. Adding a rule means adding a row, which gives cross-surface
coverage for free.

Runtime-only rules (`union-min-datasets`, `multisearch-min-subsearch`) assert
**silence** on the compiled surface (their command rule is absent there, so the
detector no-ops) and fire only on the runtime surface. Where the bundled grammar
fixture cannot parse a construct (it predates `multisearch`), the runtime
positive is left to Layer C rather than faked.

## Layer C / C′ / C″ — live engine oracle (needs a cluster)

`scripts/ppl_lint_oracle.js`. Uses a live cluster as the oracle. Each rule runs
as a **triggering-vs-control pair** of the same shape — only the suspected defect
differs, so the signal is the divergence between the two, never a hand-typed
label.

- **Layer C (result-frame).** Trigger is LOUD (4xx/5xx) while control is OK.
  Definitive for *loud-premise* rules (`field-validation`,
  `invalid-capture-group-name` on engines that reject the bad name).
- **Layer C′ (plan oracle).** Calls `_explain` on both queries and matches the
  Calcite plan against a per-rule structural signature. Definitive for
  *silent-premise* rules because the plan encodes the defect the result frame
  loses: `DIVIDE($n, 0)` in the projection (division-by-zero), `SAFE_CAST` in the
  filter (type-mismatch), an absent `SORT->` before the `LIMIT` pushdown
  (head-without-sort). A legitimately-empty result and a silently-wrong one
  produce **different plans**, so the ambiguity that blinds a result-frame oracle
  does not exist here.
- **Layer C″ (value assertion).** A per-rule predicate on the result frame at a
  finer granularity than same/different — an all-null computed column
  (division-by-zero), a null aggregate (agg-on-text), zero-count-while-control-
  positive (type-mismatch). Independent corroboration of C′.

```
node scripts/ppl_lint_oracle.js [host] [index]
# defaults: http://localhost:9200 accounts
```

### Reading a drift report

A rule reports **AGREE** only when every sub-layer it declares positively
confirms the premise on this engine. Otherwise it reports **DRIFT** with the
observed verdicts, and the script exits non-zero. DRIFT is **informational** — it
tells the rule author to re-check the rule's `appliesTo` (minVersion / maxVersion
/ engine) and `severity` in `rules_catalog.json`. It is **never** an auto-edit.

Example: on OpenSearch 3.8.0-SNAPSHOT the oracle reports 5/6 AGREE and flags

```
⚠️  invalid-capture-group-name: premise unconfirmed on 3.8.0-SNAPSHOT.
```

because 3.8 accepts `grok "%{WORD:1bad}"` (HTTP 200) rather than rejecting it —
a real premise change the author should reconcile with the rule's `appliesTo`
(tracked against sql#4549).

### Why not run Layer C in CI

OSD's GitHub-Actions CI has no standing PPL/SQL + Calcite cluster. Until one
exists (with a named owner), Layer C is a local-dev / pre-release manual check.
Layers A and B carry the PR-time guarantee on their own.
