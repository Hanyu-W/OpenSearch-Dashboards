# Backport: make field-validation fire on the compiled (sub-3.6) surface

**Target PR:** [#12298 — PPL Linter Field Validation + Command Typo Fix](https://github.com/opensearch-project/OpenSearch-Dashboards/pull/12298)
**Target branch:** `ppl-lint-pr4` (checked out at `~/IdeaProjects/OSD-pr4-rebase`)
**Reference implementation:** `poc-ppl-linter-v3`, commit `8050c7de20 "Port PPL lint to 3.5 fallback"` (canonical), plus the equivalent `codex/ppl-runtime-only-all-grammars` line. Both carry the same fix and both add `field_slot_shape_text.ts` + `analyzer_lint.test.ts`.
**Author of the fix upstream:** Hanyu Wei
**Date:** 2026-07-10

---

## 0. TL;DR — answering the two live questions

**"Was `codex/ppl-runtime-only-all-grammars` ever backported to poc-v3?"**
It's the other way around. poc-v3 already contains the canonical fix (`8050c7de20` + `4869385330`, dated 2026-07-10), and the codex branch is a parallel sibling built off the same `poc-ppl-linter-v3` merge-base (`ac597e90f0`). They are **content-siblings, not a port pair** — `git patch-id` shows even the "same-titled" commits differ (poc-v3 `351b2e43b7` = `d6bbb49…`, codex `06800a4af3` = `0f60487…`). Both branches have `field_slot_shape_text.ts`, `analyzer_lint.test.ts`, and the `detectCompiledFieldSlotShape` branch. So: **nothing needs porting *between* codex and poc-v3** — the fix lives in both. What's missing is porting it **down to the PR branch `ppl-lint-pr4`**, which is a much older cut (32 commits ahead of the merge-base, 34 behind poc-v3) and still has the compiled surface gated off.

**"How do I ungate field-validation on the PR so it isn't runtime-only?"**
That's the rest of this doc. But first, an important correction to the framing.

---

## 1. What "runtime-only" actually means on `ppl-lint-pr4` (verified empirically)

The PR description says:

> Field Validation will only run with the runtime grammar bundle enabled.

That is **only half true**, and the half that's false matters for how much work this is. field-validation is a **merged detector with two independent passes** (`packages/osd-monaco/src/ppl/lint/rules/field_validation.ts:430`):

| Pass | What it flags | Compiled-surface (sub-3.6) status on pr4 today |
|------|---------------|-----------------------------------------------|
| **PASS 2 — existence** | `where respose > 1` → *Unknown field "respose". Did you mean "response"?* | **Already fires.** Not surface-gated. |
| **PASS 1 — shape** | `grok field=body` → *grok expects a field name here…* | **Deferred → returns `[]`** on `compiled-simplified`. |

I proved this by running the pr4 analyzer directly (via `yarn test:jest` against a throwaway probe in `packages/osd-monaco/src/ppl/lint/__tests__/`):

```
analyzer.lint('source=accounts | where respose > 1', { fields: new Set(['response','age','balance']) })
  → PROBE_EXISTENCE = ["Unknown field \"respose\". Did you mean \"response\"?"]      ✅ fires on compiled surface

analyzer.lint('source=accounts | grok field=email "%{x}"', { fields: {...} })
  → PROBE_SHAPE = []                                                                 ❌ deferred on compiled surface

analyzer.lint('source=accounts | where respose > 1', {})
  → PROBE_NOFIELDS = []                                                              ✅ self-suppress w/o field list (R22.3)
```

Why the existence pass already works on pr4: the host **already forwards `fields`** into the compiled worker. `language.ts:277-291` builds a `workerContext` with `fields: Array.from(...)`, `ppl.worker.ts:34-56` rebuilds the `Set`, and `ppl_language_analyzer.ts:159` runs `runLint` with `grammarSurface: 'compiled-simplified'`. `detectUnknownFields` (`field_validation.ts:137`) is *not* gated on surface — it self-gates only on an empty field list. So the "field typo → did you mean" experience already lights up on a 3.5 cluster **as long as a dataset is selected** (the loadFields effect populates the cache — `query_editor.tsx:166` and `use_query_panel_editor.ts`).

So the accurate statement of the gap is:

> On `ppl-lint-pr4`, only **PASS 1 (the `grok/parse/patterns field=` shape check)** is runtime-only. It hard-returns `[]` on the compiled surface (`field_validation.ts:435-438`), plus there's a secondary compiled-surface hack in PASS 2 (`skipSourceKeywords`, lines 158/191) that this fix cleans up.

### 1.1 Why PASS 1 was gated in the first place

On the **compiled-simplified** grammar, `grok field=body` doesn't parse into the clean `comparisonOperator`/`fieldExpression`/`literalValue` subtree that the runtime bundle produces. The simplified grammar tokenizes `field` as the `FIELD` keyword and error-recovers into a shape with terminal children, so the parse-tree predicate in `detectFieldSlotShape` can't recognize it — and worse, that input *is already a generic syntax error* on the compiled grammar, so the team deferred it to the syntax channel rather than emit a confusing partial finding.

The poc-v3 fix's insight: don't try to make the parse-tree predicate work on the broken tree. Instead, run a **narrow, self-contained text-side scanner** (`findCompiledFieldSlotShapeMatches`) that finds exactly the `grok|parse|patterns field=<bareField>` shape from the raw query string, and only on the compiled surface. It's comment/quote-aware and only fires on the one unambiguous backend-accepted typo, so it can't regress the zero-false-positive bar.

---

## 2. Scope of the backport

Six code changes + three test changes. The heavy lift is one new file (`field_slot_shape_text.ts`, ~260 LOC, copied verbatim from poc-v3) and a rewrite of `field_validation.ts`'s shape dispatch. Everything else is small plumbing.

| # | File | Change | Risk |
|---|------|--------|------|
| A | `packages/osd-monaco/src/ppl/lint/field_slot_shape_text.ts` | **NEW** — text-side field-slot scanner | none (pure fn) |
| B | `packages/osd-monaco/src/ppl/lint/types.ts` | Add `sourceText?: string` to `LintRunContext` | none (additive) |
| C | `packages/osd-monaco/src/ppl/ppl_language_analyzer.ts` | Pass `sourceText: effectiveCode` into `runLint` context | none |
| D | `packages/osd-monaco/src/ppl/lint/rules/field_validation.ts` | Route compiled surface to `detectCompiledFieldSlotShape`; drop the `skipSourceKeywords` hack | medium |
| E | `packages/osd-monaco/src/ppl/lint/__tests__/field_slot_shape.test.ts` | Update the "surface gate" describe block | low |
| F | `packages/osd-monaco/src/ppl/lint/__tests__/field_slot_shape_text.test.ts` | **NEW** — unit tests for the text scanner | none |
| G | `packages/osd-monaco/src/ppl/lint/__tests__/analyzer_lint.test.ts` | **NEW** — end-to-end compiled-surface regression coverage | none |

> **Deliberately out of scope.** poc-v3's `8050c7de20` also touched the runtime worker context refactor (`WorkerLintContextPayload`, `worker_context.ts`, `hydrateWorkerLintContext`), the `version_filter.ts` empty-string handling, `management_app` advanced-settings JSON support, and the server `ui_settings.ts` JSON-array migration. **None of those are needed to ungate field-validation.** They're part of a larger refactor and would balloon the PR. This doc ports the minimal surface-fix only. (If you want the source-keyword handling to also survive, see §3, Change D, note 2 — I keep pr4's existing `SOURCE_KEYWORDS` skip rather than porting poc-v3's `isCompiledSourceKeywordExpression`, because the latter *depends on* `sourceText` and the offset math, and pr4's simpler skip already passes its tests.)

---

## 3. The changes, with diffs

### Change A — new file `field_slot_shape_text.ts`

Copy it verbatim from poc-v3. It has zero dependencies beyond `DiagnosticRange`:

```bash
cd ~/IdeaProjects/OSD-pr4-rebase
git show poc-ppl-linter-v3:packages/osd-monaco/src/ppl/lint/field_slot_shape_text.ts \
  > packages/osd-monaco/src/ppl/lint/field_slot_shape_text.ts
```

For reference, its public surface (the only thing the detector calls):

```ts
export interface FieldSlotShapeMatch {
  commandName: 'grokCommand' | 'parseCommand' | 'patternsCommand';
  keyword: 'grok' | 'parse' | 'patterns';
  expressionText: string;   // e.g. "field=body"
  replacement?: string;     // e.g. "body" (the bare field to rewrite to)
  range: DiagnosticRange;   // precise 1-based-line / 0-based-col span over "field=body"
}

export function findCompiledFieldSlotShapeMatches(sourceText: string): FieldSlotShapeMatch[];
```

Key behaviors it guarantees (all covered by its own test, Change F):
- Fires only on `grok|parse|patterns` (NOT `rex` — `rex field=` is legitimate).
- Requires the keyword to be exactly `field` (`fieldName=body` does not match).
- Comment- and quote-aware: `eval x = "grok field=body"` and `// grok field=body` are ignored.
- Handles spaced (`field = body`), case-insensitive (`Grok Field=body`), and backtick paths (`` field=`body.with.dot` ``).
- No replacement offered when the RHS isn't a bare field path (`field=body+other` → flagged with no fix; `field=` → not flagged).

### Change B — `types.ts`: add `sourceText` to `LintRunContext`

pr4 `types.ts:46-51`:

```ts
export interface LintRunContext extends LintPayloadContext {
  dataSourceId?: string;
  dataSourceVersion?: string;
  grammarSurface?: 'compiled-simplified' | 'runtime-bundle';
  grammarHash?: string;
}
```

Add one optional field:

```diff
 export interface LintRunContext extends LintPayloadContext {
   dataSourceId?: string;
   dataSourceVersion?: string;
+  /**
+   * Original source text, used by detectors that need a narrow text-side
+   * fallback on the compiled grammar surface (e.g. field-validation's field-slot
+   * shape pass, which cannot read `grok field=body` off the simplified parse
+   * tree). Set by `PPLLanguageAnalyzer.lint`; absent on the runtime bridge path.
+   */
+  sourceText?: string;
   grammarSurface?: 'compiled-simplified' | 'runtime-bundle';
   grammarHash?: string;
 }
```

> This is additive and structured-clone-irrelevant — `sourceText` is only ever set **inside** the worker (Change C), never sent across `postMessage`, so no change to `SerializableLintContext` / `workerContext` is required.

### Change C — `ppl_language_analyzer.ts`: thread `sourceText` in

pr4 `ppl_language_analyzer.ts:167-173`:

```ts
      const tree = parser.root();

      const diagnostics = runLint(tree, {
        ruleNameToIndex: createCompiledRuleNameToIndex(),
        dataSourceVersion: context?.dataSourceVersion,
        context: { ...context, grammarSurface: 'compiled-simplified' },
      });
```

```diff
       const tree = parser.root();

       const diagnostics = runLint(tree, {
         ruleNameToIndex: createCompiledRuleNameToIndex(),
         dataSourceVersion: context?.dataSourceVersion,
-        context: { ...context, grammarSurface: 'compiled-simplified' },
+        // Declare the surface AND the source text so the field-slot shape pass
+        // can run a narrow text-side detector here (on the simplified grammar
+        // `grok field=body` error-recovers and can't be read off the tree).
+        context: { ...context, sourceText: effectiveCode, grammarSurface: 'compiled-simplified' },
       });
```

> `effectiveCode` is already in scope at `ppl_language_analyzer.ts:163` (it's the pipe-first-adjusted query). Using it (not `code`) keeps the column math consistent with the pipe-first remap that runs a few lines later.

### Change D — `field_validation.ts`: route the compiled surface to the text detector

This is the substantive change. Three edits inside `field_validation.ts`.

**D.1 — import the scanner.** pr4 imports (lines 6-18) currently pull `nearestWithinThreshold` from `../edit_distance`. Add the new import:

```diff
 import type { ParserRuleContext, ParseTree } from 'antlr4ng';
 import { isRuleNode } from '../rule_index';
 import { Diagnostic, DiagnosticRange } from '../diagnostic';
+import { findCompiledFieldSlotShapeMatches } from '../field_slot_shape_text';
 import { CatalogEntry, Detector, LintRunContext } from '../types';
 import { buildPipelineShape, collectAlternateSourceSubtrees } from '../pipeline_shape';
 import {
   findAllDescendantsByRule,
   findChildByRule,
   isParserRuleContext,
   RuleNameToIndex,
 } from '../rule_index';
 import { rangeFromContext } from '../range_utils';
 import { nearestWithinThreshold } from '../edit_distance';
```

**D.2 — add the compiled-surface detector.** Insert this new function right after `detectFieldSlotShape` ends (pr4 line 383) and before `rangeContains` (pr4 line 392). It mirrors pr4's existing **runtime** shape emit (`field_validation.ts:364-378`): `severity: config.severity` (which the catalog defaults to `error` — `rules_catalog.json:24`) and the same generic message. This keeps a single user-facing severity toggle for the whole rule — a user who sets `field-validation` to `warning` gets `warning` on both surfaces, and the default stays red because the catalog default is `error`. It differs from poc-v3's compiled path, which hard-codes `'error'` + a Splunk-specific string; we deliberately match pr4's own convention instead (the runtime pass at line 366-372 documents exactly this reasoning).

```ts
/**
 * Compiled-surface counterpart to `detectFieldSlotShape`. On the simplified
 * grammar `grok field=body` error-recovers and can't be recognized off the
 * parse tree, so scan the raw source text for exactly that one backend-accepted
 * typo. Fires only when `sourceText` is present (the analyzer sets it).
 */
function detectCompiledFieldSlotShape(
  sourceText: string | undefined,
  config: CatalogEntry
): Diagnostic[] {
  if (!sourceText) {
    return [];
  }

  return findCompiledFieldSlotShapeMatches(sourceText).map((match) => ({
    ruleId: config.id,
    // Honor the rule's single severity toggle (catalog default is `error`),
    // matching the runtime shape pass — not a hard-coded `error` — so a user who
    // downgrades field-validation to `warning` sees it consistently on both
    // grammar surfaces.
    severity: config.severity,
    // Same generic wording as the runtime shape pass. It flags any non-bare-field
    // shape, so it avoids a Splunk-specific message.
    message: `${match.keyword} expects a field name here, not an expression.`,
    range: match.range,
    docUrl: SHAPE_DOC_URL[match.commandName] ?? config.docUrl,
    hoverFacts: { field: match.expressionText },
    ...(match.replacement
      ? {
          fix: {
            title: `Remove "field=" (use "${match.replacement}")`,
            text: match.replacement,
          },
        }
      : {}),
  }));
}
```

**D.3 — dispatch to it in the detector.** pr4 `field_validation.ts:430-445`:

```ts
export const fieldValidationDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  // PASS 1 — shape. Needs no field list. Defer on the simplified surface (its
  // error-recovery makes `field=` a syntax error already); the implicit
  // zero-structure check in `detectFieldSlotShape` is the fallback for callers
  // that don't declare a surface.
  const shapeDiagnostics =
    context.grammarSurface === 'compiled-simplified'
      ? []
      : detectFieldSlotShape(tree, config, ruleNameToIndex);

  // PASS 2 — existence (self-gates on empty fields).
  const existenceDiagnostics = detectUnknownFields(tree, config, context, ruleNameToIndex);

  // PASS 3 — drop existence findings the shape pass already covers.
  return suppressContained(shapeDiagnostics, existenceDiagnostics);
};
```

```diff
 export const fieldValidationDetector: Detector = (tree, config, context, ruleNameToIndex) => {
-  // PASS 1 — shape. Needs no field list. Defer on the simplified surface (its
-  // error-recovery makes `field=` a syntax error already); the implicit
-  // zero-structure check in `detectFieldSlotShape` is the fallback for callers
-  // that don't declare a surface.
-  const shapeDiagnostics =
-    context.grammarSurface === 'compiled-simplified'
-      ? []
-      : detectFieldSlotShape(tree, config, ruleNameToIndex);
+  // PASS 1 — shape. Needs no field list. On the runtime bundle read it off the
+  // parse tree; on the compiled-simplified surface the same input error-recovers
+  // and can't be read off the tree, so scan the source text for the one
+  // backend-accepted `field=` typo instead. Callers that declare no surface
+  // (unit tests, older callers) fall through to the tree-based pass.
+  const shapeDiagnostics =
+    context.grammarSurface === 'compiled-simplified'
+      ? detectCompiledFieldSlotShape(context.sourceText, config)
+      : detectFieldSlotShape(tree, config, ruleNameToIndex);

   // PASS 2 — existence (self-gates on empty fields).
   const existenceDiagnostics = detectUnknownFields(tree, config, context, ruleNameToIndex);

   // PASS 3 — drop existence findings the shape pass already covers.
   return suppressContained(shapeDiagnostics, existenceDiagnostics);
 };
```

> **Note 1 — overlap suppression already works.** `suppressContained` (pr4 line 408) compares `DiagnosticRange`s. `detectCompiledFieldSlotShape` produces ranges from `findCompiledFieldSlotShapeMatches` in the same 1-based-line / 0-based-column convention as `rangeFromContext`, so a compiled-surface shape error correctly swallows any existence finding on the misparsed `field` token. No change to PASS 3 needed.
>
> **Note 2 — leave PASS 2's `skipSourceKeywords` alone (minimal-port choice).** poc-v3 additionally *replaces* pr4's `SOURCE_KEYWORDS` skip (lines 36, 158, 191) with a more precise `isCompiledSourceKeywordExpression` that reads `context.sourceText` to confirm the `source`/`index` token is actually followed by `=` before the first pipe. That's a false-positive-quality refinement, **not** part of ungating the shape pass, and it drags in ~40 LOC of offset math. Keep pr4's existing `skipSourceKeywords` as-is for this PR. (If you later want the refinement, it's a self-contained follow-up now that `sourceText` is on the context.)

### Change E — update `field_slot_shape.test.ts` "surface gate" block

pr4 `field_slot_shape.test.ts:124-131` currently asserts the compiled surface returns `[]`:

```ts
  describe('surface gate', () => {
    it('defers on the compiled-simplified surface (syntax channel owns it)', () => {
      // Even on a tree that contains the misparse, an explicit simplified
      // surface suppresses the shape pass.
      expect(shapeDiagnostics('source=t | grok field=body "x"', 'compiled-simplified')).toEqual([]);
    });
  });
```

Note the helper (pr4 lines 47-51) does **not** pass `sourceText`:

```ts
function shapeDiagnostics(query: string, surface?: LintRunContext['grammarSurface']): Diagnostic[] {
  const tree = buildTree(query);
  const context: LintRunContext = surface ? { grammarSurface: surface } : {};
  return fieldValidationDetector(tree, config, context, ruleNameToIndex);
}
```

So `shapeDiagnostics(..., 'compiled-simplified')` will *still* return `[]` after the fix (no `sourceText` → `detectCompiledFieldSlotShape` early-returns). That existing assertion stays green, but its *meaning* flips from "deferred by design" to "self-suppresses without source text". Replace the block with poc-v3's version (`field_slot_shape.test.ts:137-155`), which tests both halves:

```diff
   describe('surface gate', () => {
-    it('defers on the compiled-simplified surface (syntax channel owns it)', () => {
-      // Even on a tree that contains the misparse, an explicit simplified
-      // surface suppresses the shape pass.
-      expect(shapeDiagnostics('source=t | grok field=body "x"', 'compiled-simplified')).toEqual([]);
-    });
+    it('uses source text on the compiled-simplified surface', () => {
+      const query = 'source=t | grok field=body "x"';
+      const tree = buildTree(query);
+      const diags = fieldValidationDetector(
+        tree,
+        config,
+        { grammarSurface: 'compiled-simplified', sourceText: query },
+        ruleNameToIndex
+      );
+
+      expect(diags).toHaveLength(1);
+      expect(diags[0].severity).toBe(config.severity);
+      expect(diags[0].fix?.text).toBe('body');
+    });
+
+    it('self-suppresses on compiled-simplified when source text is absent', () => {
+      expect(shapeDiagnostics('source=t | grok field=body "x"', 'compiled-simplified')).toEqual([]);
+    });
   });
```

> **Severity assertion — use `config.severity`, not a literal.** In *this* test file `config.severity` is `'warning'` (line 26), while the real catalog default is `'error'` (`rules_catalog.json:24`). Because Change D.2 emits `config.severity`, the assertion must read `expect(diags[0].severity).toBe(config.severity)` — asserting a hard `'error'` here would fail against the test's own `'warning'` config. (poc-v3's version asserts `'error'` because its compiled path hard-coded `'error'`; we don't, so don't copy that literal.) The runtime-bundle shape assertion at pr4 line 59 already uses `config.severity` and is unaffected — the two passes now match.

### Change F — new `field_slot_shape_text.test.ts`

Copy poc-v3's dedicated unit test for the scanner verbatim — it's self-contained (imports only `findCompiledFieldSlotShapeMatches`):

```bash
git show poc-ppl-linter-v3:packages/osd-monaco/src/ppl/lint/__tests__/field_slot_shape_text.test.ts \
  > packages/osd-monaco/src/ppl/lint/__tests__/field_slot_shape_text.test.ts
```

It covers precise ranges, spaced/case-insensitive/backtick forms, the `rex`/`fieldName`/`field=`/`field=body+other` non-matches, and comment/quote immunity — exactly the behaviors Change A promises.

### Change G — new `analyzer_lint.test.ts` (end-to-end regression)

This is the guard that field-aware linting fires on the **compiled analyzer** (the 3.5 path), not just via unit-testing the detector in isolation. Port the relevant describe blocks from poc-v3's `analyzer_lint.test.ts`. At minimum include the field-existence + compiled-shape coverage (poc-v3 `4869385330` adds the existence half):

```ts
// packages/osd-monaco/src/ppl/lint/__tests__/analyzer_lint.test.ts
import { getPPLLanguageAnalyzer } from '../../ppl_language_analyzer';

describe('PPLLanguageAnalyzer.lint (compiled surface)', () => {
  const analyzer = getPPLLanguageAnalyzer();
  const ruleIds = (q: string, ctx?: object) =>
    analyzer.lint(q, ctx as any).diagnostics.map((d) => d.ruleId);

  describe('field-slot shape (compiled surface via source text)', () => {
    it('flags grok field=body with a remove-field= fix', () => {
      const d = analyzer
        .lint('source=logs | grok field=body "%{WORD:x}"', { fields: new Set(['body']) })
        .diagnostics.find((x) => x.ruleId === 'field-validation');
      expect(d?.message).toContain('grok expects a field name');
      expect(d?.fix?.text).toBe('body');
    });
  });

  describe('field-validation existence pass (compiled surface, with field list)', () => {
    it('flags an unknown field and suggests the closest known field', () => {
      const d = analyzer
        .lint('source=logs | where severtyText = "x"', {
          fields: new Set(['severityText', 'body', 'status']),
        })
        .diagnostics.find((x) => x.ruleId === 'field-validation');
      expect(d?.message).toContain('Unknown field "severtyText"');
      expect(d?.message).toContain('Did you mean "severityText"');
    });

    it('does not flag a field that exists in the list', () => {
      expect(
        ruleIds('source=logs | where severityText = "x"', { fields: new Set(['severityText']) })
      ).not.toContain('field-validation');
    });

    it('self-suppresses when no field list is present (R22.3)', () => {
      expect(ruleIds('source=logs | where severtyText = "x"')).not.toContain('field-validation');
    });
  });
});
```

> Grab poc-v3's fuller version if you want its other cases:
> `git show poc-ppl-linter-v3:packages/osd-monaco/src/ppl/lint/__tests__/analyzer_lint.test.ts`

---

## 4. Verification

```bash
cd ~/IdeaProjects/OSD-pr4-rebase

# 1. The engine package — the four suites that touch field-validation:
yarn test:jest packages/osd-monaco/src/ppl/lint/__tests__/field_slot_shape.test.ts --no-coverage
yarn test:jest packages/osd-monaco/src/ppl/lint/__tests__/field_slot_shape_text.test.ts --no-coverage
yarn test:jest packages/osd-monaco/src/ppl/lint/__tests__/analyzer_lint.test.ts --no-coverage
yarn test:jest packages/osd-monaco/src/ppl/lint/__tests__/field_validation_alt_source.test.ts --no-coverage

# 2. Whole PPL lint engine + data plugin lint wiring (matches the PR's own test list):
yarn test:jest packages/osd-monaco/src/ppl --no-coverage
yarn test:jest src/plugins/data/public/antlr/opensearch_ppl --no-coverage
yarn test:jest src/plugins/data/public/ppl_lint --no-coverage

# 3. Type check (sourceText addition is additive; should be clean):
yarn typecheck
```

> Use `yarn test:jest`, **not** `yarn jest` — the bare `jest` invocation doesn't apply the osd-monaco babel transform and fails with "Cannot use import statement outside a module". (Confirmed while probing pr4.)

**Live smoke test** (requires a **sub-3.6** cluster so the compiled fallback path is taken — `shouldFetchFromBackend` gates the runtime bundle on `>=3.6.0`, `ppl_grammar_cache.ts:167-172`):

1. `queryEnhancements.ppl.lint.enabled: true` in `opensearch_dashboards.yml`, restart.
2. Point at a **3.5** data source (or one whose version is `<3.6`), select a dataset in Explore.
3. Type `source=<idx> | grok field=<realField> "%{WORD:x}"`.
   - **Before:** no lint marker (shape pass returned `[]`); at most a raw ANTLR syntax squiggle.
   - **After:** an error marker (default severity, since the catalog defaults `field-validation` to `error`) reading *"grok expects a field name here, not an expression."* with a **Remove "field=" (use "…")** quick-fix.
4. Sanity-check the existence pass still works on the same cluster: `source=<idx> | where <typo> > 1` → *Unknown field "…". Did you mean "…"?* (This already worked pre-fix — confirm no regression.)

---

## 5. Severity: `config.severity`, defaulted to `error` by the catalog

The compiled shape path emits `severity: config.severity` (Change D.2), **not** a hard-coded `'error'`. The default is still `error` because the catalog entry declares it (`rules_catalog.json:24`, added by commit `501624fc0a "…default field-validation to error"`). This gives the whole rule a **single severity toggle**: the default is red, but a user who downgrades `field-validation` to `warning` via the rules uiSetting sees `warning` consistently across both the runtime and compiled surfaces. This matches pr4's existing runtime shape pass, which already emits `config.severity` for exactly this reason (see its comment at `field_validation.ts:366-372`).

This is the one place this backport **diverges from poc-v3**, which hard-codes `'error'` on the compiled path. We don't — matching pr4's own convention keeps the two surfaces symmetric and honors the toggle. Make sure the Change E test asserts `config.severity` (not a literal `'error'`), since that test file sets `config.severity = 'warning'`.

**Landing-order note (per merged-PR memory):** if #12298 lands second after the #12274-family work, `field-validation`'s catalog `severity` field may be adopted from whichever PR lands first. That's fine — since the emit reads `config.severity`, the compiled path automatically follows whatever the merged catalog says; there's no literal to reconcile.
