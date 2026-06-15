# PPL Linter — CR Split Plan

How to break the `poc-ppl-linter-v3` branch into a reviewable stacked-CR chain
so it doesn't get stuck in CR hell.

## The problem

The branch is a POC *narrative*, not a set of reviewable CRs:

| Commit | Summary | Size |
|---|---|---|
| `d0e937e636` | add PPL lint framework with catalog, diagnostics, editor integration | **47 files, 3388 ins** |
| `96f6d3dd8c` | populate isCalcite and clean up PPL lint rules | 14 files, 193 ins |
| `9c31e6dd6f` | add five silent-failure PPL lint rules | 15 files, 967 ins |
| `36e8c6d46b` | add static quick fixes for two deterministic rules | 10 files, 340 ins |
| `daea281f34` | debounce keystroke-driven lint highlighting | 1 file, 26 ins |
| `7ae1c5d160` | rename lint provider to bridge + add quick-fix side table | **23 files, 1877 ins** |

Total: ~6,500 lines / 71 files vs `main`, plus uncommitted hover-card and
doc-link work on top.

Two CR-hell triggers:
- The first commit bundles framework + diagnostics + catalog + editor
  integration + first rule batch + benchmark harness + grammar-runtime changes.
- The "rename to bridge" commit mixes a **mechanical rename** with a
  **feature add** (quick-fix side table) in one 1,877-line diff.

## The fact that makes it sliceable

Every rule detector under `rules/` imports **only the framework**
(`diagnostic`, `types`, `rule_index`, `range_utils`) — never another rule.
Dependency layering is clean:

```
framework  →  rules  →  editor integration  →  quick fixes  →  UX
```

Land them in that order. Each CR builds + tests green on its own, so a reviewer
can check it out in isolation.

## The stack (bottom-up)

### CR1 — Lint framework, no rules, not wired in (~600–700 lines)
- `types.ts`, `diagnostic.ts`, `diagnostic_to_marker.ts`, `rule_index.ts`,
  `range_utils.ts`, `detector_registry.ts` (empty registry), `catalog.ts` +
  `rules_catalog.json`, `lint_runner.ts`
- Their unit tests
- **Zero app behavior change** — pure scaffolding. The foundation everyone
  reviews once.

### CR2 — Grammar runtime plumbing (~400 lines)
- `runtime_grammar_utils.ts`, `runtime_lint.ts`, `ppl_grammar_cache` changes
  under `src/plugins/data/public/antlr/opensearch_ppl/`
- Conceptually separate from "lint rules"; a different owner likely reviews
  antlr. Land alone so the antlr owner reviews antlr, not lint logic.

### CR3–5 — Rules in batches of ~5, each with its tests
Rules are independent, so group by theme (one mental model per CR):

- **Silent-failure rules** (already a commit): `division_by_zero`,
  `agg_on_text`, `flat_object_subfield`, `type_mismatch_numeric`,
  `enabled_false_object`
- **Unsupported-feature rules**: `disabled_join_type`,
  `unsupported_window_function`, `dedup_consecutive_unsupported`,
  `union_min_datasets`, `multisearch_min_subsearch`
- **Validation/structural rules**: `field_validation`, `expand_on_non_array`,
  `wildcard_source_zero_match`, `invalid_capture_group_name`,
  `replace_wildcard_asymmetry`, `head_without_sort`

Each CR just adds N files under `rules/` + N `registerDetector` lines + tests.
Trivial to review against the framework approved in CR1.

### CR6 — Editor integration behind a flag (~500 lines)
- `lint_bridge.ts`, `plugin.ts`, `query_editor.tsx`, `lint_context.ts`,
  `use_query_panel_editor.ts`, the `ui_settings.ts` flag
- The **only** CR that changes user-visible behavior. Keep it small and gated
  so it merges before every rule is perfect.

### CR7 — Quick fixes (~340 lines)
- `code_action_provider.ts`, `fix_registry.ts` + tests. Purely additive on top
  of integration.

### CR8 — Benchmark harness, on its own (~1,400 lines)
- The entire `__bench__/` dir. Gates nothing; nobody wants to review a perf
  harness interleaved with logic. Split out, or leave on the POC branch.

## Three things that disproportionately keep PRs stuck

1. **Keep the `*_PLAN.md` files and `test-results/` out of every CR.** The plan
   docs and the uncommitted hover/doc-link work are a *separate future stack* —
   keep them entirely off this chain or a reviewer scope-creeps into them.
2. **Split the rename.** "rename provider→bridge" should be a pure mechanical CR
   (rubber-stamp) separate from "add quick-fix side table" (real logic). Mixing
   them forces a logic reviewer to wade through rename noise.
3. **Lead each CR description with engine ground-truth.** The rules already
   carry anchored evidence (e.g. division-by-zero "verified live, OpenSearch
   3.7: `field / 0` → null, HTTP 200"). Put that in the CR description so
   reviewers don't re-litigate rule correctness — that's what stalls lint CRs
   most.
