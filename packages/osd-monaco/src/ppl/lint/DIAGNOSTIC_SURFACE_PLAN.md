# PPL Lint — Diagnostic Surface Plan (Specific Doc Links + Rich Hover Card)

**Author:** Hanyu Wei (`weihanyu@`)
**Date:** 2026-06-12
**Scope:** `packages/osd-monaco/src/ppl/lint/` (+ one provider registration in `ppl/language.ts`)
**Status:** Proposal
**Supersedes:** `DOC_LINK_PLAN.md` (Part A here) and `HOVER_CARD_PLAN.md` (Part B here) — combined because
both target the *same* lint marker and the *same* catalog, and share one offline test harness.

**Goal:** Make a PPL lint finding's on-hover surface genuinely useful per rule — both the **link**
(`code.target`) and the **body** (everything around `message`) — instead of the same short message +
same generic link on every squiggle.

---

## 0. TL;DR

Hovering a lint squiggle today shows the **same short message + the same generic, redirect-broken doc
link for every rule**. Two stacked causes, two halves of one fix:

- **Part A — the link is generic and broken.** All **16** rules in `rules_catalog.json` point at one
  stale URL: `https://opensearch.org/docs/latest/search-plugins/sql/ppl/functions/`. That base path
  migrated; the old `/search-plugins/sql/ppl/cmd/<x>/` paths now **404** on redirect. → Re-point each
  rule at a specific, verified anchor on the current docs (`docs.opensearch.org/latest/sql-and-ppl/…`),
  and add doc-drift tests so a moved/renamed page is caught.

- **Part B — there is no body, because no hover provider is registered.** `language.ts` registers only
  the formatter and the quick-fix code-action provider, so "view more" is Monaco's *built-in* marker
  hover, which can render only `message` + `code.target`. → Register one
  `monaco.languages.registerHoverProvider` returning a `MarkdownString`, re-associating rich per-rule
  content via the proven side-table pattern (`fix_registry.ts`).

Both halves key off the **same catalog** and the **same marker `code` field** (`code.value` = ruleId,
`code.target` = docUrl), so they merge into one plan with **one master per-rule table** (§5) and one
offline test harness (§9). The linter already holds, client-side, everything the body needs: each
detector's verified "Engine ground truth" docblock, and the live `LintRunContext` (engine, version,
field types, visible indices) plus the query text.

Headline numbers: 15 of 16 doc targets verified live (HTTP 200 + anchor present); the 16th (`union`) is
unpublished upstream and handled as a doc gap (§6). Part A is data-only (no code changes beyond the
catalog + tests); Part B Phase 1 lights up all 16 rules with no detector changes.

---

## 1. Current state (verified from code, 2026-06-12)

| Fact | Evidence |
|------|----------|
| All 16 rules share one generic `docUrl`. | `rules_catalog.json`; each entry `"docUrl": ".../search-plugins/sql/ppl/functions/"`. |
| That base path is stale; command pages 404 on redirect. | Live check; docs migrated to `docs.opensearch.org/latest/sql-and-ppl/…`. |
| Single edit point for the link. | Every detector emits `docUrl: config.docUrl` → `Diagnostic.docUrl` → `marker.code.target` in `diagnostic_to_marker.ts:79-84`. Changing a link = one catalog string. |
| `catalog.ts` validates `docUrl` is a non-empty string but not its shape/specificity. | `catalog.ts:validateCatalogEntry` (`typeof … !== 'string'` drops the entry). That gap is what lets all 16 share one link. |
| "View more" is Monaco's native marker hover, not a custom component. | No hover provider registered in `language.ts:registerPPLLanguage` (lines 344-377 register language, config, tokenizer, formatter, syntax highlighting, code-action — no hover). |
| Native marker hover **is** enabled in the host editor. | `query_editor_options.ts` / `shared_editor_options.ts` don't set `hover: { enabled: false }`; `fixedOverflowWidgets: true` lets the widget render outside the editor's clip bounds. |
| The only per-rule data the hover shows today is `message` + `code.target`. | `diagnostic_to_marker.ts` sets `message` (plain string) and `code: { value: ruleId, target: docUrl }`. |
| Custom properties hung on a marker are dropped by Monaco. | `fix_registry.ts` docblock: `MarkerService._toMarker` rebuilds each marker from a fixed field list (`code`, `severity`, `message`, `source`, the four position fields, `relatedInformation`, `tags`) and discards anything else. |
| A side-table keyed by `position + message` already re-associates dropped data. | `fix_registry.ts` (`markerFixKey`, `setModelFixes`, `getModelFix`) + the writer loop in `language.ts:processLintHighlighting` (lines 232-241). |
| Detectors carry rich, verified engine knowledge that never reaches the user. | Every `rules/*.ts` has an "Engine ground truth" docblock (e.g. `division_by_zero.ts:11-15`). |
| Some detectors already interpolate instance data into `message`. | `type_mismatch_numeric.ts:131-137` (field, esType, literal); `enabled_false_object.ts:60-66` (field, root object). |
| Live per-query context is available client-side at lint time. | `LintRunContext` in `types.ts:49-67`: `dataSourceVersion`, `isCalcite`, `fields`, `typeMap`, `disabledObjectFields`, `visibleIndices`, `settings`. |
| Tests are pure offline Jest; no network/nock/msw harness in `osd-monaco`. | So the live doc-drift tier (§9.2) must be opt-in and never run in default `yarn test:jest`. |

**Conclusion:** the catalog is the single source of truth for both halves. The link half is a data edit
+ drift tests. The body half adds a render surface (hover provider) + a content table that transcribes
knowledge the detectors already verified. Both pivot on the same `code` field that rides every marker.

---

## 2. The shared pivot: fields that survive the MarkerService rebuild

A hover provider and the code-action provider both receive the marker as it exists **after**
`setModelMarkers` (post-rebuild). Only these survive and are usable as lookup keys / content:

- `message` (verbatim) — already per-instance for some rules.
- `code.value` (the **ruleId**) and `code.target` (the **docUrl**). **`code.value` is our primary key
  for both halves.**
- `severity`, `source` (`'ppl-lint'`), the four position fields.
- `relatedInformation[]`, `tags[]`.

Everything else must come from a side-table populated at lint time and read lazily on hover. Two
re-association strategies (both used, for different content):

- **By ruleId (`code.value`)** → *static* import-time tables. The catalog already maps ruleId → docUrl;
  `engine_outcomes.ts` (new) maps ruleId → body facts. No per-model state. Used for rule-level content.
- **By `markerFixKey` (position + message)** → *per-model* side-tables. `fix_registry.ts` (existing,
  for fixes) and `hover_registry.ts` (new, for per-instance facts). Cleared on the same lifecycle
  events. Used for per-instance content.

---

# Part A — Specific Doc Links + Doc-Drift Tests

## 3. Published-docs ground truth (confirmed 2026-06-12)

- Base path migrated to **`docs.opensearch.org/latest/sql-and-ppl/...`**, generated from
  `opensearch-project/documentation-website` under `_sql-and-ppl/`.
  - Commands: `…/sql-and-ppl/ppl/commands/<cmd>/`
  - Functions: `…/sql-and-ppl/ppl/functions/<category>/`
  - Limitations: `…/sql-and-ppl/limitation/` (singular). **Its published headings differ from the `sql`
    repo's `docs/user/ppl/limitations/limitations.md`** — don't assume the repo's titles exist live.
  - Type/mapping behavior: `…/mappings/...` (separate from the SQL/PPL section).
- **Anchor slug algorithm** (verified against live HTML `id=`): lowercase, spaces→`-`, punctuation
  dropped, **underscores preserved**. Confirmed live: `var_samp`, `max_match`,
  `string-to-numeric-type-conversion`, `disabling-object-fields`.
- **Ground-truth method** (WebFetch's summarizer returns the nav sidebar, not page bodies — use curl):

  ```bash
  # live rendered anchor ids
  curl -sL "https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/rex/" \
    | grep -oE '<h[1-4][^>]*id="[^"]*"' | sed -E 's/.*id="([^"]*)".*/\1/'
  # a soft-404 shows the id "oops-this-isnt-the-page-youre-looking-for"

  # verbatim headings / body text from source
  curl -sL "https://raw.githubusercontent.com/opensearch-project/documentation-website/main/_sql-and-ppl/ppl/commands/rex.md"
  ```

The recommended `docUrl` per rule (with quality + rationale) is folded into the **master table (§5)**.
Full URLs use the prefix `https://docs.opensearch.org/latest`. All 15 published targets confirmed live
on 2026-06-12 (HTTP 200 + anchor `id` present).

### 3.1 The `union` doc gap

`union` exists in the `sql` repo source (`docs/user/ppl/cmd/union.md`, with `## Limitations` stating
"At least two datasets must be specified") but is **not yet published** to `documentation-website` —
absent from the command tree; the live page soft-404s.

Decision: **do not** link `union-min-datasets` at the multisearch page (wrong command, would mislead).
Until `union` is published, set its `docUrl` to the PPL commands index root:

```
https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/
```

and track a follow-up (§11) to re-point at `…/ppl/commands/union/#limitations` once live. The drift
test's `expectedUnpublished` list (§9.2) records this so the suite *reminds* us when `union` appears.

---

# Part B — Rich Hover Card ("View More")

## 4. Architecture

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
                          ──reads── code.target ───────────► docUrl  (from catalog, Part A)
                          ──reads── markerFixKey ─────────► hover_registry.get(...)  (per-instance)
                          ──reads── markerFixKey ─────────► fix_registry.get(...)    (fix preview)
                                          │
                                          ▼
                              renderHoverCard() → MarkdownString  ("view more" body)
```

**Cost model:** the only per-keystroke addition is populating `hover_registry` in the existing marker
loop (a `Map.set` per finding — same shape as the fix loop already there). All rendering and any scans
(e.g. nearby-index filtering) happen **lazily inside the hover callback**, which fires only on user
hover. Honors the frontend-only + no-per-keystroke-cost constraints (Eric's position: no backend
`_lint` API, no per-keystroke network).

### 4.1 The hover card content model

One layered `MarkdownString`. Each section renders only when its data exists, so simple rules show a
short card and rich rules show a full one. Section order (top = highest value):

```
  <severity glyph> <ruleId> · <Severity>
  ─────────────────────────────────────────
  Engine behavior — <what the engine actually does, from the detector docblock>           [static, §5]
  Your query      — <instance facts: actual field, actual esType, actual literal/indices>  [per-instance]
  Why <severity>  — <decode error/warning/info into the runtime outcome class>             [static]
  Suggested fix   — `<before>` → `<after>`                                                 [when a DiagnosticFix exists]
  Safe to ignore  — <the false-positive escape hatch>                                       [omitted for error severity]
  Learn more →    <the specific docUrl from Part A>                                          [Part A link]
```

`RuleHoverContent` (static, per ruleId — the hand-authored surface in `engine_outcomes.ts`):

```ts
interface RuleHoverContent {
  engineBehavior: string;   // one precise sentence; from the detector docblock
  failureClass: 'silent-null' | 'silent-empty' | 'engine-throw' | 'nondeterministic' | 'fallback';
  safeToIgnoreWhen?: string; // MUST be absent for error-severity rules
  verifiedVersion?: string;  // when the docblock states it (e.g. '3.7')
}
```

`HoverFacts` (per-instance, populated by a detector from data it already has):

```ts
interface HoverFacts {
  field?: string;             // actual offending field name
  esType?: string;            // its actual mapped type, from typeMap
  literal?: string;           // actual string literal / divisor text
  suggestion?: string;        // already computed by field-validation
  candidateIndices?: string[]; // pre-sliced (<=5) for wildcard-source-zero-match
  totalIndices?: number;      // "matched 0 of 47"
}
```

> Store **pre-sliced** candidate lists (≤5 strings), not the full `visibleIndices` array, to avoid
> holding a large reference per diagnostic. The substring filter runs once at emit time on data the
> detector already iterates.

---

## 5. Master per-rule table (link + body, all 16 rules)

One row per rule covering both halves. `docUrl` shows the anchor suffix; prefix is
`https://docs.opensearch.org/latest`. `Q` = link quality (exact / close / weak / gap). `Sev` from the
catalog. `FC` = failure class. `Inst` = per-instance facts worth surfacing. Engine-behavior lines are
condensed from each detector's verified "Engine ground truth" docblock.

| Rule | Sev | `docUrl` (suffix) | Q | Engine behavior (card line) | FC | Safe-to-ignore | Inst |
|------|-----|-------------------|---|------------------------------|----|----------------|------|
| `invalid-capture-group-name` | error | `…/ppl/commands/rex/#parameters` | exact | `rex` capture-group names must match the Java group-name rule (`RegexCommonUtils.isValidJavaRegexGroupName`); underscores/leading digits rejected at execution. | engine-throw | — (error) | group name, fixed form |
| `unsupported-window-function-in-eventstats` | error | `…/ppl/commands/eventstats/#aggregation-functions` | close | Only `row_number` is a valid window function (`WINDOW_FUNC_MAPPING`); `first`/`last` are aggregation-only and rejected in `eventstats`/`streamstats` (≥3.4.0). | engine-throw | — (error) | function name |
| `dedup-consecutive-unsupported` | warn | `…/limitation/#unsupported-functionalities` | exact | On **Calcite**, `dedup consecutive=true` throws `CalciteUnsupportedException`, unconditionally caught by the Calcite→v2 fallback (v2 `DedupeOperator` supports it). Succeeds via fallback. | fallback | When the Calcite→v2 fallback is enabled/tested (query runs, slower path). | engine, version |
| `replace-wildcard-asymmetry` | error | `…/ppl/commands/replace/#limitations` | exact | On **Calcite** (`replace` is Calcite-only), `IllegalArgumentException` when replacement wildcard count ≠ pattern count and is non-zero. **Not** caught by fallback (`fallback.allowed=false`). | engine-throw | — (error) | pattern/replacement counts |
| `union-min-datasets` | error | `…/ppl/commands/` *(gap, §3.1)* | gap | `union` with < 2 datasets throws "Union command requires at least two datasets" (Calcite, ≥3.7.0). | engine-throw | — (error) | — |
| `multisearch-min-subsearch` | error | `…/ppl/commands/multisearch/#limitations` | exact | `multisearch` with < 2 subsearches throws "Multisearch command requires at least two subsearches" at AST-build time (engine-independent, ≥3.4.0). | engine-throw | — (error) | — |
| `disabled-join-type` | error | `…/ppl/commands/join/#limitations` | exact | `right`/`cross`/`full` joins are high-cost and disabled by default (`Join.java`, `validateJoinType`). `outer` aliases `left` and is never flagged. All engines. | engine-throw | When `allJoinTypesAllowed` is set on the cluster (`settings`). | join type |
| `head-without-sort` | info | `…/ppl/commands/head/` *(page root)* | weak | `head` with no preceding `sort` returns **nondeterministic** rows (shard-assignment / Lucene segment order; can change between identical re-runs). | nondeterministic | When any N rows suffice (not the top N) and order doesn't matter. | — |
| `field-validation` | error | `…/ppl/commands/fields/` *(page root)* | weak | Field not present in the index field set (nor created upstream) — unknown-field resolution fails. | engine-throw | When the field is created by an upstream `eval`/`rename` the linter can't see. | field, suggestion, nearby fields |
| `expand-on-non-array` | warn | `…/ppl/commands/expand/#limitations` | exact | OpenSearch has no literal `array` type; arrays are `nested`/`object`, so codegen can succeed — advisory. (#5065) | silent-empty | When the field is genuinely `nested`/`object` array-shaped. | field, esType |
| `wildcard-source-zero-match` | info | `…/ppl/commands/search/` *(page root)* | weak | A `source=` wildcard matching **zero** visible indices returns no data — advisory host-side check. | silent-empty | When the matching index will exist at run time but isn't visible now. | pattern, candidate indices, total |
| `division-by-zero` | warn | `…/ppl/functions/expressions/#arithmetic-operators` | close | `x / 0` evaluates to **null** (HTTP 200, `[[null]]`, type `double`) — no error; the null propagates into downstream stats/eval. *Verified 3.7.* | silent-null | When null propagation is intended (e.g. handled by `coalesce(...)` downstream). | divisor text |
| `agg-on-text` | warn | `…/ppl/functions/aggregations/` *(page root)* | weak | A numeric agg (`avg`/`sum`/`stddev`/`var`/…) on a `text`/`keyword` field returns **null** (type `double`, HTTP 200) — silent. `count`/`min`/`max` excluded. *Verified 3.7.* | silent-null | When you intend a non-numeric agg, or the field is numeric-as-keyword and you'll cast. | field, esType, aggName |
| `flat-object-subfield` | error | `…/mappings/supported-field-types/flat-object/#limitations` | close | Referencing a subfield of a `flat_object` raises `IllegalArgumentException: Field [...] not found` (HTTP 400) — query rejected. *Verified 3.7.* | engine-throw | — (error) | field path |
| `type-mismatch-numeric` | warn | `…/ppl/functions/conversion/#string-to-numeric-type-conversion` | exact | Comparing a numeric field to a **non-coercible** string literal (`age = "thirty"`) matches **0 rows** (HTTP 200, no error). Coercible numerics like `"32"` are fine. *Verified 3.7.* | silent-empty | (none — almost always a real bug) | field, esType, literal |
| `enabled-false-object` | warn | `…/mappings/mapping-parameters/enabled/#disabling-object-fields` | close | A field inside an object mapped `enabled: false` is **not indexed**; references resolve to **null** (type `undefined`, HTTP 200). *Verified 3.7.* | silent-null | When you only read it from `_source` post-fetch, never filter/agg/sort on it. | field, root object |

> The `docUrl`/`Q` columns are Part A (catalog edit + drift snapshot). The `Engine behavior` / `FC` /
> `Safe-to-ignore` / `Inst` columns are Part B (`engine_outcomes.ts` + per-instance detectors). Both are
> reviewed against the detector docblock that verified them, in one table, so a future rule change
> updates link and body together.

### 5.1 Rendered card examples (the actual "view more" body)

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
leaves the user stuck; the personalized card (read lazily from `context.visibleIndices`) — plus the now-
specific `search` page link — hands them the answer.

---

## 6. New + changed files

### New

| File | Part | Responsibility |
|------|------|----------------|
| `lint/hover/engine_outcomes.ts` | B | Static `Record<ruleId, RuleHoverContent>` — engine behavior, failure class, safe-to-ignore, verified version. Import-time constant; O(1) lookup by `code.value`. The single hand-authored body surface. |
| `lint/hover/hover_registry.ts` | B | Per-model side-table for per-instance `HoverFacts` keyed by `markerFixKey`. Near-copy of `fix_registry.ts` (globalThis-shared, `WeakMap<model, Map>`, `set/get/clear`). |
| `lint/hover/hover_card.ts` | B | `renderHoverCard(marker, facts?, fix?) → IMarkdownString`. Pure function composing static + per-instance + fix-preview + link into markdown. Unit-testable with no Monaco editor. |
| `lint/hover/hover_provider.ts` | B | `pplLintHoverProvider: monaco.languages.HoverProvider`. Finds `PPL_LINT` marker(s) under the position, looks up content, returns `{ range, contents: [renderHoverCard(...)] }`; returns `null` when no lint marker is under the cursor. |
| `__tests__/__fixtures__/doc_links.snapshot.json` | A | Per-rule pinned link metadata (docUrl, page, anchor, quality, excerpt, contentHash). |
| `__tests__/doc_links.test.ts` | A | Tier-1 offline link-snapshot test (runs in default CI). |
| `__tests__/doc_links.live.test.ts` | A | Tier-2 live drift test (`describe.skip` unless `RUN_DOC_DRIFT_LIVE=1`). |
| `scripts/capture_doc_snapshot.ts` | A | Regenerates the snapshot fixture from live docs after an intentional re-point. |
| `lint/hover/__tests__/hover_card.test.ts` | B | Rendered-markdown assertions per rule / failure class. |
| `lint/hover/__tests__/hover_provider.test.ts` | B | Provider returns content for a `ppl-lint` marker under the cursor; `null` otherwise; ignores non-`ppl-lint` markers. |
| `lint/hover/__tests__/engine_outcomes.test.ts` | B | Coverage guard: every enabled catalog rule has an `engine_outcomes` entry and vice-versa. |

### Changed

| File | Part | Change |
|------|------|--------|
| `rules_catalog.json` | A | Set each rule's `docUrl` to its §5 value (16 one-line changes; `union` → commands index root). No detector changes for the link itself. |
| `ppl/language.ts` | B | (a) Register the hover provider in `registerPPLLanguage` alongside the code-action provider (~lines 366-369), add its disposable to the returned `dispose`. (b) In the marker loop in `processLintHighlighting` (lines 232-241), also populate `hover_registry` per finding; clear it on the same events that already call `clearModelFixes` (lines 201, 208, 300, 325). |
| `lint/diagnostic.ts` | B | Add optional `hoverFacts?: HoverFacts` to `Diagnostic` (parallel to `fix?`). |
| `lint/diagnostic_to_marker.ts` | B | Carry `hoverFacts` as a transient marker property (stripped into the side-table in `language.ts`), exactly as `fix` is carried today. |
| `rules/*.ts` (subset) | B | For the per-instance rules only (Phase 3), populate `hoverFacts` from data the detector already has: `agg-on-text`, `type-mismatch-numeric`, `expand-on-non-array`, `flat-object-subfield`, `enabled-false-object`, `wildcard-source-zero-match`, `field-validation`. |
| `catalog.ts` | A (optional) | Optionally extend `validateCatalogEntry` to reject the legacy generic URL and require the `https://docs.opensearch.org/` prefix — moves the link guard from test-time to load-time. Keep permissive enough that a future docs-domain change is a deliberate edit. |

> Part A is data-only (catalog + tests, plus optional `catalog.ts` hardening). Part B Phases 1-2 need no
> detector changes — they key off the ruleId that already rides every marker.

---

## 7. Phased rollout

| Phase | Part | Deliverable | Effort | Value |
|-------|------|-------------|--------|-------|
| **A1 — Re-point links** | A | Edit the 16 `docUrl`s (§5) + add the offline snapshot fixture + Tier-1 test. | **S** | high — fixes the broken/generic link for every rule. |
| **A2 — Drift safety net** | A | Tier-2 live drift test + capture script + nightly CI job + optional `catalog.ts` hardening. | **S–M** | medium — keeps links honest over time. |
| **B1 — Hover foundation** | B | Hover provider + static `engine_outcomes.ts` for all 16 rules. Lands: engine-behavior line, "why this severity", safe-to-ignore, and the now-specific `docUrl` rendered as a markdown link. No detector changes. | **S** | **high** — every squiggle becomes rule-specific immediately. |
| **B2 — Quick-fix preview** | B | Render the existing `DiagnosticFix` (`before → after`) in the card via `getModelFix`. No new fix logic. | **S** | high |
| **B3 — Per-instance context** | B | `hover_registry.ts` + `HoverFacts`; populate from the 7 field/index-aware detectors. Lands "Your query" lines + wildcard index enumeration. | **M** | **high** — the "this is about MY query" moment. |
| **B4 — Live engine/version strip (optional)** | B | "On your 3.5 Calcite cluster…" for the version/engine-gated rules only (`dedup`, `replace`, `union`, `multisearch`, `unsupported-window`, `disabled-join`). Read context lazily on hover. | **S** | medium — scope to rules with a real predicate to avoid boilerplate. |

**Suggested order:** A1 → B1 (both S, both light up all 16 rules; together they fix link *and* body) →
B2 → B3 → A2/B4 as time allows. A1 and B1 are each independently shippable.

**Explicitly out of scope (cut in review):** a session-level "mute this rule" affordance. It sprawls
into `language.ts` marker filtering, a new status-bar UI component, and `localStorage` persistence —
well beyond this surface, and it touches user-data retention. Track separately if wanted.

---

## 8. Constraints honored (review checklist)

- [x] **Frontend-only.** All body content derives from the bundled catalog, the static
      `engine_outcomes` table, and `LintRunContext` data already in hand. No backend `_lint` API; no
      network on hover. (Live doc-drift fetches run only in the opt-in nightly job, never in the editor.)
- [x] **No per-keystroke cost.** The only lint-time addition is a `Map.set` per finding (mirrors the
      existing fix loop). Rendering + any scans are lazy in the hover callback.
- [x] **MarkerService rebuild respected.** Static content keys off `code.value`/`code.target` (both
      survive); per-instance content uses the `markerFixKey` side-table (proven by `fix_registry.ts`).
      Nothing relies on a custom marker property reaching the provider.
- [x] **Scales to dozens of rules.** Adding a rule = one catalog `docUrl` + one `engine_outcomes` entry,
      both asserted present by coverage tests. One generic card renderer; no bespoke UI per rule.
- [x] **Never disrupts the editor.** Provider returns `null` for non-lint hovers (default hover passes
      through); reads are defensive (missing entry → shorter card, never throws). Mirrors the
      best-effort posture of `processLintHighlighting`.
- [x] **Owner isolation.** Provider filters to `source: 'ppl-lint'` markers, never touching the
      `PPL_WORKER` syntax-error channel.

---

## 9. Testing (one offline harness, two suites)

OSD's default `yarn test:jest` is offline/sandboxed (no nock/msw in `osd-monaco`). So everything offline
runs in normal CI; the only network-dependent tier is opt-in.

### 9.1 Offline (always-on, default CI)

**Link suite (Part A — `doc_links.test.ts`)**, asserting against a committed snapshot fixture:
1. **Catalog ↔ snapshot id parity** — every catalog rule has a snapshot entry and vice-versa.
2. **`docUrl` equality** — catalog `docUrl` === snapshot `docUrl` per rule (the deterministic guard
   against an un-mirrored link edit).
3. **No legacy generic URL** — no `docUrl` contains `search-plugins/sql/ppl`.
4. **URL shape** — each `docUrl` starts with `https://docs.opensearch.org/latest/`; any rule whose
   snapshot `quality` is `exact`/`close` has a non-empty `#anchor`. `weak`/`gap` may be page-root.
5. **`expectedUnpublished` honesty** — `union-min-datasets` carries `quality: "gap"` and is listed in an
   `expectedUnpublished` array rather than asserting a dead anchor.

**Body suite (Part B):**
6. **`engine_outcomes` coverage** — every enabled `getBundledCatalog()` rule has an `engine_outcomes`
   entry and vice-versa (mirror of test #1).
7. **No safe-to-ignore on errors** — assert `safeToIgnoreWhen` is absent for any rule whose catalog
   `severity === 'error'`.
8. **`hover_card` rendering** — for a finding per failure class, assert the markdown contains the
   engine-behavior line, the correct severity decode, the fix preview when a fix is present, and the
   `docUrl` link; per-instance: assert the actual field/type/divisor/candidates appear.
9. **`hover_provider` behavior** — returns content for a `ppl-lint` marker under the position; `null`
   when none; ignores non-`ppl-lint` markers; overlapping markers → innermost/first lint marker wins.
10. **`hover_registry` lifecycle** — entries cleared on the same events as `clearModelFixes` (lint
    disabled, language change away, model dispose); no stale facts outliving their markers.

### 9.2 Live (Part A — env-gated, nightly / on-demand)

`doc_links.live.test.ts`, guarded so it's a no-op unless enabled:

```ts
const LIVE = process.env.RUN_DOC_DRIFT_LIVE === '1';
(LIVE ? describe : describe.skip)('doc links — live drift', () => { … });
```

For each rule's snapshot entry, fetch the `page` URL (Node 22 global `fetch`; 15s timeout; small retry
for transient 5xx) and assert, with two separated signals:

- **Link liveness (hard fail):** HTTP 200; body does **not** contain
  `id="oops-this-isnt-the-page-youre-looking-for"` (the soft-404 marker); and if the entry has an
  `anchor`, the body contains `id="<anchor>"`. Catches page moves, slug renames, section deletions.
- **Content drift (soft):** recompute `contentHash` from the section-scoped documenting excerpt (§9.3)
  and compare. Mismatch **fails by default** (a behavior rewrite gets a human re-confirm), with
  `DOC_DRIFT_HASH=warn` downgrading a hash-only mismatch to `console.warn`. Liveness failures are never
  downgradable.

`expectedUnpublished` rules (e.g. `union`) are asserted the *other* way: their future URL is expected to
404 today; if it starts resolving, the test fails with "union is now published — re-point its docUrl and
remove it from expectedUnpublished."

**Wiring:** a `test:doc-drift` script (`RUN_DOC_DRIFT_LIVE=1 jest doc_links.live`) + a nightly GitHub
Actions job running only this file. **Not** in the default `build-test` matrix (external-site dependency
would make required CI flaky).

### 9.3 The "documenting excerpt" + hash

Pin a small verbatim excerpt (1–3 sentences) of the text under each anchor that documents the behavior
(e.g. rex's "Group names must start with a letter…"), plus its `sha256`, in the fixture. The live tier
extracts the section under the anchor, normalizes whitespace, and hashes it — deliberately section-
scoped, so unrelated edits elsewhere on a big page don't trip the hash. `capture_doc_snapshot.ts`
regenerates the fixture after an intentional re-point (one command, not hand-edited hashes).

### 9.4 Manual

Local OSD, explore query editor: type each rule's trigger query, hover, confirm the card body and that
"Learn more" opens the correct specific page.

---

## 10. Doc-improvement follow-ups (separate from this change)

These rules have weak/absent published coverage; §5 points them at the closest honest target, but each
deserves an upstream doc improvement so a future re-point can be `exact`. Track in Taskei under the lint
project (sql#5405); **not** blockers for this change.

| Rule | Gap | Suggested upstream fix |
|------|-----|------------------------|
| `union-min-datasets` | `union` command page unpublished | Publish `_sql-and-ppl/ppl/commands/union.md`; re-point to `…/union/#limitations`. |
| `head-without-sort` | No nondeterminism note on `head` page | Add: `head` without preceding `sort` returns nondeterministic rows. |
| `field-validation` | No unknown-field-resolution section | Document field-resolution behavior (likely on `fields` or a PPL semantics page). |
| `wildcard-source-zero-match` | No zero-match note for `source=` wildcards | Add a note on `search`/source patterns matching zero indices. |
| `agg-on-text` | Null-on-text not documented per-aggregation | Note that numeric aggs on `text`/`keyword` return null (aggregations page). |

---

## 11. Open questions

1. **`code.value` shape.** The lint marker sets `code: { value: ruleId, target: docUrl }` only **when
   `docUrl` is present** (`diagnostic_to_marker.ts:79`). All rules have a `docUrl`, so the ruleId is
   always there — but the hover provider should fall back to matching by `source` + message if `code`
   is ever absent, so it degrades gracefully.
2. **Native hover vs. EUI styling.** A `MarkdownString` hover inherits Monaco's hover widget styling. If
   product wants OUI/EUI-styled cards (severity chips, badges), B1 still ships value as markdown; a
   richer content-widget rendering is a later, larger option (deferred).
3. **Markdown link trust.** `MarkdownString` needs `isTrusted`/`supportHtml` considered only if we embed
   command links; plain external `https://docs.opensearch.org` links don't. Keep links plain in B1–B4.
4. **Interaction telemetry.** Design-doc Phase 6 wants hover-interaction telemetry ("fired → user edited"
   vs "fired → user ran anyway"). The hover provider is the natural emit point; out of scope here, but
   structure the provider so a telemetry hook drops in without reshaping it.
5. **`catalog.ts` URL hardening (A, optional).** Worth doing at load-time, but keep it permissive enough
   that a future docs-domain migration is a deliberate one-line edit, not a wall of dropped entries.

---

## 12. Why this shape

- **One catalog, one `code` field, one table.** The link (`code.target`) and the body (keyed by
  `code.value`) ride the same marker and the same catalog, so merging is natural: §5 is one row per rule
  covering both, and a future rule change updates link and body together instead of drifting apart.
- **Reuses the proven side-table pattern.** `fix_registry.ts` already solved "rich data that must
  survive the marker rebuild." `hover_registry.ts` is a near-copy — low-risk, familiar to reviewers.
- **Catalog + docblocks stay the source of truth.** Engine facts live next to the detector that verified
  them; the card and the link are renderings of existing knowledge, not new places to invent claims.
- **Data-first / static-first, personalize-later.** A1 (link) and B1 (static body) need no detector
  changes and cover all 16 rules, so value lands before the per-instance plumbing.
- **Two test tiers, honest gaps.** Offline catalog↔snapshot equality + `engine_outcomes` coverage block
  bad edits deterministically in CI; the opt-in live tier catches external doc drift where flakiness is
  acceptable; doc gaps (`union`) are first-class (`quality`, `expectedUnpublished`) rather than hidden
  behind a plausible-but-wrong anchor.
```
