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
  /** semver; absent = open-ended (capped at OSD_KNOWN_VERSION). */
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
}

/**
 * Host-supplied lint context. Mirrors `PPLLintContext` in `lint_provider.ts`,
 * narrowed to the fields detectors consume. Defined here to avoid the engine
 * depending on the provider module.
 */
export interface LintRunContext {
  dataSourceId?: string;
  dataSourceVersion?: string;
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
