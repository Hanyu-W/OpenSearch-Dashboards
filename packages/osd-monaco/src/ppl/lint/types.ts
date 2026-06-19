/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ParserRuleContext } from 'antlr4ng';
import { Diagnostic, LintSeverity } from './diagnostic';
import { RuleNameToIndex } from './rule_index';

/**
 * Version / engine applicability predicate for a rule.
 */
export interface AppliesTo {
  /** semver; rule must not fire below this version. */
  minVersion?: string;
  /** semver; hard ceiling — rule must not fire above this. Absent = no upper bound. */
  maxVersion?: string;
  /** engine predicate; absent = no engine filtering. */
  engine?: 'calcite';
}

/**
 * A single rule entry in the bundled JSON catalog. The catalog is the single
 * source of truth for which rules are enabled, their severity, message, doc
 * link, and version applicability.
 */
export interface CatalogEntry {
  /** rule identifier, e.g. 'invalid-capture-group-name'. */
  id: string;
  /** detector registry key. */
  detector: string;
  enabled: boolean;
  severity: LintSeverity;
  /** hardcoded English (v1). */
  message: string;
  docUrl: string;
  appliesTo: AppliesTo;
  /** marks runtime-grammar-only rules (documentation/coverage aid). */
  runtimeOnly?: boolean;
  /** Bucket-B context gate. */
  needsContext?: boolean;
  /**
   * Marks a rule whose detector reads an `_explain` plan rather than the parse
   * tree. Such rules run in a separate, asynchronous pass (see
   * `explain/run_explain_lint.ts`) and are skipped by the synchronous tree loop
   * in `lint_runner.ts` so they never log as "inert" there.
   */
  needsExplain?: boolean;
}

/**
 * Per-rule configuration overrides, keyed by rule id. Each entry shallow-merges
 * over the bundled catalog entry (see `mergeConfig` in `lint_runner.ts`).
 *
 * Two producers populate this: a future runtime grammar bundle (the original
 * `bundleOverrides` option) and the user/workspace/admin uiSettings resolved on
 * the host (threaded through `LintRunContext.overrides`). Defined here, rather
 * than in `lint_runner.ts`, so `LintRunContext` can carry it without the engine
 * depending on the runner module.
 */
export type BundleRuleOverrides = Record<string, Partial<CatalogEntry>>;

/**
 * The host-supplied field metadata and settings a lint pass consumes. Shared by
 * the engine's `LintRunContext` and the bridge's `PPLLintContext` (in
 * `lint_bridge.ts`) so the two never drift — each extends this base and adds the
 * fields specific to its layer (engine: grammar surface; bridge: the http
 * client). Defined here so the bridge can reference it without the engine
 * depending on the bridge module.
 */
export interface LintPayloadContext {
  /** True when the data source is identified as running the Calcite engine. */
  isCalcite?: boolean;
  /** Index field names; empty/absent gates Bucket-B rules. */
  fields?: Set<string>;
  /** Field name -> esTypes[0]. */
  typeMap?: Map<string, string>;
  /**
   * Names of object fields mapped with `enabled: false`. Such fields are absent
   * from `_field_caps` (and therefore from `typeMap`), so this set is sourced
   * separately from a `_mappings` walk. Used by `enabled-false-object`.
   */
  disabledObjectFields?: Set<string>;
  /** Visible index names, for wildcard-source-zero-match. */
  visibleIndices?: string[];
  settings?: { allJoinTypesAllowed?: boolean };
  /**
   * Per-rule overrides resolved from uiSettings on the host and merged over the
   * bundled catalog at run time. Layers below an explicit `bundleOverrides`
   * option (see `runLint`).
   */
  overrides?: BundleRuleOverrides;
}

/**
 * Host-supplied lint context. Extends {@link LintPayloadContext} with the
 * engine-only fields the runner threads through. Mirrors `PPLLintContext` in
 * `lint_bridge.ts` (which extends the same base), narrowed to what detectors
 * consume. Defined here to avoid the engine depending on the bridge module.
 */
export interface LintRunContext extends LintPayloadContext {
  dataSourceId?: string;
  dataSourceVersion?: string;
  /**
   * Which grammar surface produced the parse tree. The field-slot shape pass
   * (`field-validation`) branches on this: it defers to the syntax channel on
   * `compiled-simplified` (where `grok field=body` error-recovers to a syntax
   * error) and flags on `runtime-bundle` (where the same input is a silent
   * misparse). Absent for callers that don't set it (unit tests, older callers);
   * the shape pass then falls back to an implicit zero-structure heuristic.
   */
  grammarSurface?: 'compiled-simplified' | 'runtime-bundle';
  /** Identifies the runtime grammar bundle a tree came from (debugging aid). */
  grammarHash?: string;
}

/**
 * All detectors share this signature. A detector resolves the parent command's
 * rule index via `ruleNameToIndex`, finds matching nodes with the child-
 * navigation helpers, applies its engine-verified predicate, and returns zero
 * or more diagnostics. A detector whose command resolves to -1 returns [].
 */
export type Detector = (
  tree: ParserRuleContext,
  config: CatalogEntry,
  context: LintRunContext,
  ruleNameToIndex: RuleNameToIndex
) => Diagnostic[];
