# PPL Lint — Rich Hover Card ("View More") Plan

**Author:** Hanyu Wei (`weihanyu@`)
**Date:** 2026-06-12
**Scope:** `packages/osd-monaco/src/ppl/lint/` (+ one provider registration in `ppl/language.ts`)
**Status:** Proposal
**Sibling doc:** [`DOC_LINK_PLAN.md`](./DOC_LINK_PLAN.md) — re-points each rule's `docUrl`. This plan is the
content/interaction half; the two are complementary and share the same catalog as source of truth.

---

## 0. TL;DR

Hovering a lint squiggle today shows the **same** short message + the **same** generic doc link for
every rule, so "view more" is useless. Two independent causes:

1. **Every rule ships the same `docUrl`** (the generic, redirect-broken
   `opensearch.org/.../sql/ppl/functions/`). `DOC_LINK_PLAN.md` fixes this half.
2. **No hover provider is registered.** `language.ts` registers only the formatter and the quick-fix
   code-action provider. So "view more" is Monaco's *built-in* marker hover, which can render only the
   marker `message` string and the `code.target` link — nothing rule-specific beyond those two.

Meanwhile the linter already holds, **client-side**, everything needed for a genuinely useful card:
each detector's "Engine ground truth" docblock (what the engine actually does), and the live
`LintRunContext` (engine, version, field types, visible indices) plus the user's query text.

**The fix:** register one `monaco.languages.registerHoverProvider` for PPL that returns a
`MarkdownString`, re-associating rich per-finding content via a side-table — the exact pattern
`fix_registry.ts` already uses for quick-fixes. The card layers a few small sections, populated per
rule. Foundation is ~S effort and lights up all 16 rules at once; per-instance personalization is the
follow-on.

---

## 1. Current state (verified from code)

| Fact | Evidence |
|------|----------|
| "View more" is Monaco's native marker hover, not a custom component. | No hover provider registered in `language.ts` (`registerPPLLanguage`, lines 344-377 register language, config, tokenizer, formatter, syntax highlighting, code-action — no hover). |
| Native marker hover **is** enabled in the host editor. | `query_editor_options.ts` / `shared_editor_options.ts` do not set `hover: { enabled: false }`; `fixedOverflowWidgets: true` is set so the widget renders outside the editor's clip bounds. |
| The only per-rule data the hover can show today is `message` + `code.target`. | `diagnostic_to_marker.ts` sets `message` (plain string) and `code: { value: ruleId, target: docUrl }`. |
| All 16 rules currently share one generic `docUrl`. | `rules_catalog.json`; see `DOC_LINK_PLAN.md` §1. |
| Custom properties hung on a marker are dropped by Monaco. | `fix_registry.ts` docblock: `MarkerService._toMarker` rebuilds each marker from a fixed field list (`code`, `severity`, `message`, `source`, the four position fields, `relatedInformation`, `tags`) and discards anything else. |
| A side-table keyed by `position + message` already re-associates dropped data. | `fix_registry.ts` (`markerFixKey`, `setModelFixes`, `getModelFix`) + the writer loop in `language.ts:processLintHighlighting` (lines 232-241). |
| Detectors already carry rich, verified engine knowledge that never reaches the user. | Every `rules/*.ts` has an "Engine ground truth" docblock (e.g. `division_by_zero.ts:11-15`). |
| Several detectors already interpolate instance data into `message`. | `type_mismatch_numeric.ts:131-137` (field, esType, literal); `enabled_false_object.ts:60-66` (field, root object). |
| Live per-query context is available client-side at lint time. | `LintRunContext` in `types.ts:49-67`: `dataSourceVersion`, `isCalcite`, `fields`, `typeMap`, `disabledObjectFields`, `visibleIndices`, `settings`. |

**Conclusion:** the linter is sitting on the content; it just has no surface to render it on. We add
the surface (a hover provider) and the content table (per-rule static facts), then progressively wire
the live context.

---

## 2. Fields that survive the MarkerService rebuild (the hard constraint)

A hover provider receives the marker as it exists **after** `setModelMarkers`, i.e. post-rebuild. Only
these survive and are therefore usable as lookup keys / content:

- `message` (verbatim) — already per-instance for some rules.
- `code.value` (the **ruleId**) and `code.target` (the docUrl). **`code.value` is our primary key.**
- `severity`, `source` (`'ppl-lint'`), the four position fields.
- `relatedInformation[]`, `tags[]`.

Everything else must come from a **side-table** populated at lint time and read lazily on hover.

Two valid re-association strategies (we use both, for different content):

- **By ruleId (`code.value`)** → a *static* import-time table (`engine_outcomes.ts`). No per-model
  state, no lifecycle. Used for rule-level facts (engine behavior, severity rationale, safe-to-ignore).
- **By `markerFixKey` (position + message)** → a *per-model* side-table (`hover_registry.ts`,
  mirroring `fix_registry.ts`). Used for per-instance facts (the actual field, its actual type, the
  zero-match candidate indices). Cleared on the same lifecycle events as the fix table.

---

## 3. Architecture

```
                          lint pass (debounced, per-keystroke)
   detectors ──► Diagnostic[] ──► diagnosticToMarker() ──► markers[]
       │                                                      │
       │ (per-instance facts: field, esType, candidates)      │ setModelMarkers(PPL_LINT)
       ▼                                                      ▼
  hover_registry.set(model, key→HoverFacts)            Monaco MarkerService
       │  (mirror of fix_registry; lint-time write)     (rebuilds markers)
       │                                                      │
       │                          hover (lazy, user-driven)   │
       ▼                                                      ▼
  registerHoverProvider ──reads── code.value (ruleId) ──► engine_outcomes[ruleId]  (static)
                          ──reads── markerFixKey ─────────► hover_registry.get(...)  (per-instance)
                                          │
                                          ▼
                              renderHoverCard() → MarkdownString  ("view more" body)
```

**Cost model:** the only per-keystroke addition is populating `hover_registry` in the existing marker
loop (a `Map.set` per finding — same shape as the fix loop already there). All rendering and any
scans (e.g. nearby-index filtering) happen **lazily inside the hover callback**, which fires only on
user hover. This respects the frontend-only + no-per-keystroke-cost constraints (Eric's position: no
backend `_lint` API, no per-keystroke network).

---

## 4. New + changed files

### New

| File | Responsibility |
|------|----------------|
| `lint/hover/engine_outcomes.ts` | Static `Record<ruleId, RuleHoverContent>` — the per-rule fact table (engine behavior, severity rationale, safe-to-ignore, failure class). Import-time constant, O(1) lookup by `code.value`. The single hand-authored content surface. |
| `lint/hover/hover_registry.ts` | Per-model side-table for **per-instance** facts (`HoverFacts` keyed by `markerFixKey`). Near-verbatim copy of `fix_registry.ts` (globalThis-shared, `WeakMap<model, Map>`, `set/get/clear`). |
| `lint/hover/hover_card.ts` | `renderHoverCard(marker, facts?) → monaco.IMarkdownString`. Pure function: composes the static + per-instance content into markdown. Fully unit-testable with no Monaco editor. |
| `lint/hover/hover_provider.ts` | `pplLintHoverProvider: monaco.languages.HoverProvider`. `provideHover` finds the `PPL_LINT` marker(s) under the position (via `monaco.editor.getModelMarkers({ owner: 'PPL_LINT' })` filtered by range-contains), looks up content, returns `{ range, contents: [renderHoverCard(...)] }`. Returns `null` when no lint marker is under the cursor (lets the default/word hover through). |
| `lint/hover/__tests__/hover_card.test.ts` | Snapshot-ish assertions on rendered markdown per rule. |
| `lint/hover/__tests__/engine_outcomes.test.ts` | Coverage guard: every enabled catalog rule has an `engine_outcomes` entry and vice-versa (mirrors the doc-link Tier-1 test idea). |
| `lint/hover/__tests__/hover_provider.test.ts` | Provider returns content for a `ppl-lint` marker under the cursor; returns `null` otherwise; ignores non-`ppl-lint` markers. |

### Changed

| File | Change |
|------|--------|
| `ppl/language.ts` | (a) Register the hover provider in `registerPPLLanguage` alongside the code-action provider (lines ~366-369), add its disposable to the returned `dispose`. (b) In the marker loop in `processLintHighlighting` (lines 232-241), also populate `hover_registry` per finding, then clear it on the same lifecycle events that already call `clearModelFixes` (lines 201, 208, 300, 325). |
| `lint/diagnostic_to_marker.ts` | Carry per-instance `HoverFacts` the same way `fix` is carried today (attach to the marker as a transient property, stripped into the side-table in `language.ts`). Only needed for rules that emit per-instance facts. |
| `lint/diagnostic.ts` | Add optional `hoverFacts?: HoverFacts` to `Diagnostic` (parallel to `fix?`), so detectors that already compute the field/type/candidates can pass them through without re-deriving. |
| `rules/*.ts` (subset) | For the per-instance rules only (Phase 3), populate `hoverFacts` from data the detector **already** has in scope (no new computation): `agg-on-text`, `type-mismatch-numeric`, `expand-on-non-array`, `flat-object-subfield`, `enabled-false-object`, `wildcard-source-zero-match`, `field-validation`. |

> No detector logic changes for Phases 1-2 — those are pure content/registration work keyed off the
> ruleId that already rides on every marker.

---

## 5. The hover card content model

The card is one layered `MarkdownString`. Each section renders only when its data exists, so simple
rules show a short card and rich rules show a full one. Section order (top = highest value):

```
  <severity glyph> <ruleId> · <Severity>
  ─────────────────────────────────────────
  Engine behavior — <what the engine actually does, from the detector docblock>
  Your query      — <instance facts: actual field, actual esType, actual literal/divisor/indices>   [per-instance only]
  Why <severity>  — <decode error/warning/info into the runtime outcome class>
  Suggested fix   — `<before>` → `<after>`                                                            [only when a DiagnosticFix exists]
  Safe to ignore  — <the false-positive escape hatch>                                                 [omitted for error severity]
  Learn more →    <the specific docUrl from DOC_LINK_PLAN>
```

### 5.1 `RuleHoverContent` (static, per ruleId)

```ts
interface RuleHoverContent {
  /** One precise sentence: what the engine does at runtime. From the detector docblock. */
  engineBehavior: string;
  /** Runtime outcome class — drives the "Why <severity>" line and a glyph. */
  failureClass: 'silent-null' | 'silent-empty' | 'engine-throw' | 'nondeterministic' | 'fallback';
  /** Optional false-positive escape hatch. MUST be absent for error-severity rules. */
  safeToIgnoreWhen?: string;
  /** OpenSearch version the behavior was verified on, when the docblock states it. */
  verifiedVersion?: string;
}
```

### 5.2 `HoverFacts` (per-instance, populated by the detector when available)

```ts
interface HoverFacts {
  field?: string;            // the actual offending field name
  esType?: string;           // its actual mapped type, from typeMap
  literal?: string;          // the actual string literal / divisor text
  suggestion?: string;       // already computed by field-validation
  candidateIndices?: string[]; // pre-sliced (<=5) for wildcard-source-zero-match
  totalIndices?: number;     // "matched 0 of 47"
}
```

> Store **pre-sliced** candidate lists (≤5 strings), not the full `visibleIndices` array, to avoid
> holding a large reference per diagnostic. The substring filter runs once at emit time on data the
> detector already iterates.

---

## 6. Per-rule content table (all 16, grounded in the detector docblocks)

`engineBehavior` strings below are condensed from each detector's verified "Engine ground truth"
docblock. `FC` = failure class. `Inst` = has per-instance facts worth surfacing. `Sev` from the catalog.

| Rule | Sev | FC | Engine behavior (card line) | Safe-to-ignore | Inst |
|------|-----|----|------------------------------|----------------|------|
| `division-by-zero` | warn | silent-null | `x / 0` evaluates to **null** (HTTP 200, `[[null]]`, type `double`) — no error; the null propagates into downstream stats/eval. *Verified 3.7.* | When null propagation is intended (e.g. handled by `coalesce(...)` downstream). | divisor text |
| `agg-on-text` | warn | silent-null | A numeric agg (`avg`/`sum`/`stddev`/`var`/…) on a `text`/`keyword` field returns **null** with a `double` schema type — silent. `count`/`min`/`max` are excluded. *Verified 3.7.* | When you intend a non-numeric agg, or the field is numeric-as-keyword and you'll cast. | field, esType, aggName |
| `type-mismatch-numeric` | warn | silent-empty | Comparing a numeric field to a **non-coercible** string literal (`age = "thirty"`) matches **0 rows** (HTTP 200, no error). Coercible numerics like `"32"` are fine. *Verified 3.7.* | (none — almost always a real bug) | field, esType, literal |
| `enabled-false-object` | warn | silent-null | A field inside an object mapped `enabled: false` is **not indexed**; references resolve to **null** (type `undefined`, HTTP 200). *Verified 3.7.* | When you only read it from `_source` post-fetch, never filter/agg/sort on it. | field, root object |
| `flat-object-subfield` | error | engine-throw | Referencing a subfield of a `flat_object` raises `IllegalArgumentException: Field [...] not found` (HTTP 400) — query rejected. *Verified 3.7.* | — (error) | field path |
| `expand-on-non-array` | warn | silent-empty | OpenSearch has no literal `array` type; arrays are `nested`/`object`, so codegen can succeed — advisory. (#5065) | When the field is genuinely `nested`/`object` array-shaped. | field, esType |
| `field-validation` | error | engine-throw | Field not present in the index field set (nor created upstream) — unknown-field resolution fails. | When the field is created by an upstream `eval`/`rename` the linter can't see. | field, suggestion, nearby fields |
| `wildcard-source-zero-match` | info | silent-empty | A `source=` wildcard matching **zero** visible indices returns no data — advisory host-side check. | When the matching index will exist at run time but isn't visible now. | pattern, candidate indices, total |
| `head-without-sort` | info | nondeterministic | `head` with no preceding `sort` returns **nondeterministic** rows (shard-assignment / Lucene segment order; can change between identical re-runs). | When any N rows suffice (not the top N) and order doesn't matter. | — |
| `dedup-consecutive-unsupported` | warn | fallback | On **Calcite**, `dedup consecutive=true` throws `CalciteUnsupportedException`, unconditionally caught by the Calcite→v2 fallback (v2 `DedupeOperator` supports it). Succeeds via fallback. | When your cluster's Calcite→v2 fallback is enabled/tested (query runs, slower path). | engine, version |
| `replace-wildcard-asymmetry` | error | engine-throw | On **Calcite** (`replace` is Calcite-only), `IllegalArgumentException` when replacement wildcard count ≠ pattern count and is non-zero. **Not** caught by fallback (`fallback.allowed=false`). | — (error) | pattern/replacement counts |
| `disabled-join-type` | error | engine-throw | `right`/`cross`/`full` joins are high-cost and disabled by default (`Join.java`, `validateJoinType`). `outer` is an alias for `left` and is never flagged. All engines. | When `allJoinTypesAllowed` is set on the cluster (`settings`). | join type |
| `union-min-datasets` | error | engine-throw | `union` with < 2 datasets throws "Union command requires at least two datasets" (Calcite, ≥ 3.7.0). | — (error) | — |
| `multisearch-min-subsearch` | error | engine-throw | `multisearch` with < 2 subsearches throws "Multisearch command requires at least two subsearches" at AST-build time (engine-independent, ≥ 3.4.0). | — (error) | — |
| `unsupported-window-function-in-eventstats` | error | engine-throw | Only `row_number` is a valid window function (`WINDOW_FUNC_MAPPING`); `first`/`last` are aggregation-only and rejected in `eventstats`/`streamstats` (≥ 3.4.0). | — (error) | function name |
| `invalid-capture-group-name` | error | engine-throw | `rex` capture-group names must match the Java regex group-name rule (`RegexCommonUtils.isValidJavaRegexGroupName`) — underscores/leading digits rejected at execution. | — (error) | group name, fixed form |

> The `engineBehavior` and `safeToIgnoreWhen` strings get hand-authored into `engine_outcomes.ts` once,
> co-located with the detector code so they're reviewed together. The `verifiedVersion` is filled in
> for the rules whose docblock states "verified live, OpenSearch 3.7".

---

## 7. Rendered examples (the actual "view more" body)

**`division-by-zero`** on `... | eval rate = requests / 0`:

```
⚠ division-by-zero · Warning
Engine behavior — requests / 0 evaluates to null, not an error.
                  Returns HTTP 200 with [[null]] (type double). Verified on OpenSearch 3.7.
Why a warning   — the query "succeeds"; the null propagates silently into downstream
                  stats/eval. Nothing signals that the division failed.
Safe to ignore  — when you handle nulls downstream (e.g. coalesce(...)).
Learn more →     …/sql-and-ppl/ppl/functions/expressions/#arithmetic-operators
```

**`agg-on-text`** on `source=sales | stats avg(response_body)` where `response_body` is `text`:

```
⚠ agg-on-text · Warning
Engine behavior — avg on a text/keyword field returns null, not a number (HTTP 200).
Your query      — response_body is mapped as text on this index. avg() needs a numeric
                  type (integer, long, float, double, …).
Why a warning   — the query succeeds but the aggregation is null; charts show a gap/zero.
Learn more →     …/sql-and-ppl/ppl/functions/aggregations/
```

**`wildcard-source-zero-match`** on `source=logs-* | head 10` (47 indices visible, none match):

```
ℹ wildcard-source-zero-match
Your query      — source=logs-*  matched 0 of 47 visible indices.
                  Indices containing "logs": logs_2024, logs_2025, logs_archive
                  Tip: OpenSearch index names use underscores — try logs_*
Learn more →     …/sql-and-ppl/ppl/commands/search/
```

The `wildcard` case is the clearest proof of value: the generic message ("pattern matches no index")
leaves the user stuck; the personalized card (read lazily from `context.visibleIndices`) hands them the
answer.

---

## 8. Phased rollout

| Phase | Deliverable | Files | Effort | Value |
|-------|-------------|-------|--------|-------|
| **1 — Foundation** | Hover provider + static `engine_outcomes.ts` for all 16 rules. Lands: engine-behavior line, "why this severity", safe-to-ignore, and the proper per-rule `docUrl` link rendered as markdown. No detector changes. | `hover_provider.ts`, `hover_card.ts`, `engine_outcomes.ts`, register in `language.ts`, tests | **S** | **high** — every squiggle becomes rule-specific immediately. |
| **2 — Quick-fix preview** | Render the existing `DiagnosticFix` (`before → after`) inside the card. Reuses the fix already on the marker/side-table; no new fix logic. | `hover_card.ts` (+ read fix via `getModelFix`) | **S** | high |
| **3 — Per-instance context** | `hover_registry.ts` + `HoverFacts`; populate from the 7 field-aware/index-aware detectors (data they already compute). Lands "Your query" lines + the wildcard index enumeration. | `hover_registry.ts`, `diagnostic.ts`, `diagnostic_to_marker.ts`, `language.ts` marker loop, 7 `rules/*.ts` | **M** | **high** — the "this is about MY query" moment. |
| **4 — Live engine/version strip (optional)** | "On your 3.5 Calcite cluster…" for the version/engine-gated rules only (`dedup`, `replace`, `union`, `multisearch`, `unsupported-window`, `disabled-join`). Read `dataSourceVersion`/`isCalcite`/`settings` lazily on hover. | `hover_card.ts`, small `HoverFacts` additions | **S** | medium — scope to rules with a real predicate to avoid boilerplate noise. |

Phases 1-2 are independently shippable and deliver most of the value. Phase 3 is the headline feature.

**Explicitly out of scope (cut in review):** a session-level "mute this rule" affordance. It sprawls
into `language.ts` marker filtering, a new status-bar UI component, and `localStorage` persistence —
well beyond the hover surface, and it touches user-data retention. Track separately if wanted.

---

## 9. Constraints honored (review checklist)

- [x] **Frontend-only.** All content derives from the bundled catalog, the static `engine_outcomes`
      table, and `LintRunContext` data already in hand. No backend `_lint` API, no network on hover.
- [x] **No per-keystroke cost.** The only lint-time addition is a `Map.set` per finding (mirrors the
      existing fix loop). Rendering + any scans are lazy in the hover callback.
- [x] **MarkerService rebuild respected.** Static content keys off `code.value` (survives);
      per-instance content uses the `markerFixKey` side-table (proven by `fix_registry.ts`). Nothing
      relies on a custom marker property reaching the provider.
- [x] **Scales to dozens of rules.** One generic card renderer; adding a rule = one
      `engine_outcomes` entry, asserted present by a coverage test. No bespoke UI per rule.
- [x] **Never disrupts the editor.** Provider returns `null` for non-lint hovers (default hover passes
      through); all reads are defensive (missing entry → shorter card, never throws). Mirrors the
      best-effort posture of `processLintHighlighting`.
- [x] **Owner isolation.** Provider filters to `source: 'ppl-lint'` markers, never touching the
      `PPL_WORKER` syntax-error channel.

---

## 10. Testing

1. **`engine_outcomes` coverage (offline, always-on):** every enabled `getBundledCatalog()` rule has an
   `engine_outcomes` entry and every entry maps to a real rule. Mirrors `DOC_LINK_PLAN.md` Tier-1.
2. **No safe-to-ignore on errors (offline):** assert `safeToIgnoreWhen` is absent for any rule whose
   catalog `severity === 'error'` (reviewer-checklist turned into a test).
3. **`hover_card` rendering (offline):** for a representative finding per failure class, assert the
   markdown contains the engine-behavior line, the correct severity decode, the fix preview when a fix
   is present, and the `docUrl` link. Per-instance: assert the actual field/type/divisor/candidates
   appear.
4. **`hover_provider` behavior (offline, mocked model+markers):** returns content for a `ppl-lint`
   marker under the position; returns `null` when none; ignores non-`ppl-lint` markers; multiple
   overlapping markers → the innermost/first lint marker wins.
5. **`hover_registry` lifecycle:** entries cleared on the same events as `clearModelFixes`
   (lint disabled, language change away, model dispose) — no stale facts outliving their markers.
6. **Manual:** local OSD, explore query editor, type each rule's trigger query, hover, confirm the card.

All offline tests run in the default `yarn test:jest` (no network — consistent with the package's
existing pure-offline harness noted in `DOC_LINK_PLAN.md` §1).

---

## 11. Open questions

1. **`code.value` shape.** Today the lint marker sets `code: { value: ruleId, target: docUrl }` only
   **when `docUrl` is present** (`diagnostic_to_marker.ts:79`). Since all rules have a `docUrl`, the
   ruleId is always there — but the hover provider should fall back to matching by `source` + message
   if `code` is ever absent, so it degrades gracefully. (Cheap to add; flagged for the reviewer.)
2. **Native hover vs. EUI styling.** A `MarkdownString` hover inherits Monaco's hover widget styling.
   If product wants OUI/EUI-styled cards (badges, colored severity chips), Phase 1 still ships value as
   markdown; a richer content-widget rendering is a later, larger option (the brainstorm scored it
   "promising, L" — deferred).
3. **Markdown link trust.** `MarkdownString` needs `isTrusted` / `supportHtml` considered if we ever
   embed command links; plain external `https://docs.opensearch.org` links don't require it. Keep links
   plain in Phases 1-4.
4. **Interaction telemetry.** Design-doc Phase 6 wants hover-interaction telemetry ("fired → user
   edited" vs "fired → user ran anyway"). The hover provider is the natural emit point; out of scope
   here but the provider should be structured so a telemetry hook can be added without reshaping it.

---

## 12. Why this shape

- **Reuses the proven side-table pattern.** `fix_registry.ts` already solved "rich data that must
  survive the marker rebuild." The hover registry is a near-copy, so the mechanism is low-risk and
  familiar to reviewers.
- **Catalog + docblocks stay the source of truth.** Engine facts live next to the detector that
  verified them; the hover card is a rendering of existing knowledge, not a new place to invent claims.
- **Static-first, personalize-later.** Phase 1 needs zero detector changes and lights up all 16 rules,
  so value lands before the per-instance plumbing. Personalization is additive, rule-by-rule.
- **Pairs cleanly with `DOC_LINK_PLAN.md`.** That plan makes the link specific; this plan makes the
  body specific. Same catalog, same `code` field, complementary tests.
```
