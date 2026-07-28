# PPL Linter

Diagnostics for PPL queries in the Monaco query editor. Rules flag queries
that will fail at execution time, silently return wrong/empty results, or run
slowly — while the user types, before the query runs.

This README is the front door for engineers. Per-rule reference pages live in
[`docs/rules/`](docs/rules/); a parity test
(`__tests__/docs_parity.test.ts`) keeps them and the table below in sync with
`rules_catalog.json`.

## Pipeline shape

```
keystroke
  → 500ms trailing-edge debounce (language.ts, per model)
  → lint runner in the PPL web worker (lint_runner.ts)
      against the compiled simplified grammar
  → Diagnostic[] (diagnostic.ts — ruleId, range, optional fix)
  → diagnostic_to_marker.ts   ← the one place ANTLR 0-based columns
                                 become Monaco 1-based (lint path only)
  → markers, owner 'PPL_LINT'
```

Syntax errors are a separate pass with owner `'PPL_WORKER'`; the two passes
each replace only their own markers and fix tables, so one cannot clobber the
other.

## The two grammar paths

This is the least obvious part of the system and the source of most "my rule
doesn't fire" confusion.

- **Compiled simplified grammar** — ships in the bundle, always available,
  runs in the web worker. Most rules run here.
- **Runtime grammar** — fetched per data-source version and cached
  (`src/plugins/data/public/antlr/opensearch_ppl/ppl_grammar_cache.ts`,
  `runtime_lint.ts`). Rules marked `runtimeOnly` in the catalog run **only**
  here, because their commands are not part of the compiled surface. No
  selected dataset, or a data source below the supported version, means no
  runtime path and those rules stay silent.

Version applicability (`appliesTo.minVersion` / `engine`) is enforced by
`version_filter.ts`. Note `dataSourceVersion` is frequently **undefined** at
runtime; the filter's fallback behavior decides whether a versioned rule runs,
so read that file before assuming a rule fires on "old" clusters.

## What a rule needs (context flags)

| Catalog flag   | Meaning                                | Supplied by                                            |
| -------------- | -------------------------------------- | ------------------------------------------------------ |
| _(none)_       | Pure query-text analysis               | worker                                                 |
| `needsContext` | Index field mappings / visible indices | `lint_context_builder.ts` (data plugin)                |
| `needsExplain` | The query's `_explain` plan            | `explain/` + `ppl_lint/explain_cache.ts` (data plugin) |
| `runtimeOnly`  | Runtime grammar (see above)            | `runtime_lint.ts`                                      |

## Rules

Severity/default drift in this table fails `docs_parity.test.ts`. **Default**
is the _effective_ shipped default: the catalog marks every rule
`enabled: true`, but `PPL_LINT_RULE_DEFAULTS` in
`src/plugins/query_enhancements/server/ui_settings.ts` overrides three rules
to off. The uiSettings layer wins — "catalog says enabled but the rule doesn't
fire" is trap #1 in this package.

<!-- BEGIN GENERATED RULES TABLE -->

| Rule                                        | Severity | Default | Applies to       | Needs           |
| ------------------------------------------- | -------- | ------- | ---------------- | --------------- |
| `invalid-capture-group-name`                | error    | on      | all              | —               |
| `unsupported-window-function-in-eventstats` | error    | on      | 3.4.0+           | —               |
| `dedup-consecutive-unsupported`             | warning  | on      | 3.3.0+ (Calcite) | —               |
| `replace-wildcard-asymmetry`                | error    | on      | 3.4.0+ (Calcite) | runtime grammar |
| `union-min-datasets`                        | error    | on      | 3.7.0+ (Calcite) | runtime grammar |
| `multisearch-min-subsearch`                 | error    | on      | 3.4.0+           | runtime grammar |
| `disabled-join-type`                        | warning  | on      | all              | —               |
| `head-without-sort`                         | info     | on      | all              | —               |
| `field-validation`                          | error    | on      | all              | —               |
| `expand-on-non-array`                       | warning  | on      | all              | index mappings  |
| `wildcard-source-zero-match`                | info     | on      | all              | index mappings  |
| `division-by-zero`                          | warning  | on      | all              | —               |
| `agg-on-text`                               | warning  | on      | all              | index mappings  |
| `flat-object-subfield`                      | error    | on      | all              | index mappings  |
| `type-mismatch-numeric`                     | warning  | on      | all              | index mappings  |
| `enabled-false-object`                      | warning  | on      | all              | index mappings  |
| `rex-scan-cost`                             | info     | off     | all              | index mappings  |
| `operation-not-pushed`                      | warning  | off     | 3.3.0+ (Calcite) | explain plan    |
| `operation-pushed-as-script`                | info     | off     | 3.3.0+ (Calcite) | explain plan    |

<!-- END GENERATED RULES TABLE -->

## Adding a rule — registration chain

A rule that is missing any link in this chain fails silently (registered but
never fires) or fails a parity test:

1. **Catalog entry** in `rules_catalog.json` — id, severity, message,
   `howToFix`, `docUrl`, `appliesTo`, context flags.
2. **Detector** in `rules/<rule_name>.ts`, registered in `rule_index.ts` /
   `detector_registry.ts`.
3. **uiSettings default** in
   `src/plugins/query_enhancements/server/ui_settings.ts`
   (`PPL_LINT_RULE_DEFAULTS`) — must mirror the catalog, or "reset to
   default" and the sparse-storage diff disagree on the baseline.
4. **Doc-links snapshot** parity (`__tests__/doc_links.test.ts`).
5. **Per-rule doc file** in `docs/rules/` with the five required sections
   (enforced by `__tests__/docs_parity.test.ts`).
6. **Tests** in `__tests__/` — including a negative case (query that must NOT
   fire).

## UI surfaces

- **Markers** — `diagnostic_to_marker.ts` sets
  `code: { value: ruleId, target: docUrl }`, which renders the rule id as a
  clickable link.
- **Hover cards** — `hover/hover_card.ts` renders the diagnostic message,
  concise fix guidance, additive query details, and "Learn more"; guidance per
  rule lives in `rules_catalog.json`.
- **Quick fixes** — `code_action_provider.ts` reads `fix_registry.ts`, a side
  table keyed by the marker fields Monaco's MarkerService preserves (it
  rebuilds marker objects and drops extra fields — that is why fixes cannot
  ride on the marker itself). Shared via `globalThis` because this package can
  be bundled twice. A fix is attached only when the rewrite is unambiguous,
  result-preserving, and will not re-fire the rule; see the header of
  `explain/explain_quick_fix.ts` for the fully worked example of that bar.
- **AI fix** — worker side in `ai_fix/` (command id, prompt/message building,
  candidate validation); page side in
  `src/plugins/data/public/chat_tools/ppl_lint_fix_*` (chat session, card,
  apply/dismiss). Availability depends on the selected cluster's AI
  capability.

## Configuration

- Feature flag: `queryEnhancements.ppl.lint.enabled` (dynamic app config →
  capabilities → client).
- Per-rule tuning: one JSON uiSetting, `query:enhancements:pplLint:rules`,
  an object keyed by rule id with `{ enabled, severity }` values. A malformed
  stored shape is a silent no-op.
- Always pass a default to `uiSettings.get()` — it throws on unknown keys.

## Testing

- Unit tests per rule in `__tests__/`; docs parity in
  `__tests__/docs_parity.test.ts`.
- Benchmarks in `__bench__/` (lint latency, debounce model, corpus).
- Headless entry point (`headless_ppl_lint.ts` at the `ppl/` level) lets CI
  in other repos lint against a candidate grammar bundle without a browser.
