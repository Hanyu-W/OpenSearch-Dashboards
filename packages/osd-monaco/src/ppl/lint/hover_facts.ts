/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-instance facts a detector extracts about *this* finding (not the rule in
 * general): the actual offending field, its actual mapped type, the actual
 * literal/divisor, candidate indices, etc. Surfaced in the "Your query" line of
 * the hover card so the card is about the user's query, not a generic rule.
 *
 * Canonical home for the shape. `diagnostic.ts` and `hover/hover_registry.ts`
 * both alias this so the two never drift (the hover writer assigns a
 * `Diagnostic`'s facts into a `Map<…, HoverFacts>` relying on structural
 * equivalence with no conversion). Kept in `lint/` — not under `hover/` — so
 * `diagnostic.ts` references it without depending on the hover UI module.
 *
 * All fields are optional; a detector populates only what it knows. Lists are
 * pre-sliced by the detector (e.g. <=5 candidate indices) so we never hold a
 * large array reference per diagnostic.
 */
export interface HoverFacts {
  /** Actual offending field name (or dotted path). */
  field?: string;
  /** Its actual mapped esType, from typeMap. */
  esType?: string;
  /** Root object name, for enabled-false-object / flat-object subfields. */
  root?: string;
  /** Actual literal / divisor text, verbatim from the query. */
  literal?: string;
  /** Aggregation function name, for agg-on-text. */
  aggName?: string;
  /** Closest known field, already computed by field-validation. */
  suggestion?: string;
  /** Wildcard source pattern, for wildcard-source-zero-match. */
  pattern?: string;
  /** Pre-sliced (<=5) candidate index names near the pattern. */
  candidateIndices?: string[];
  /** Count of visible indices checked, for "matched 0 of N". */
  totalIndices?: number;
  /**
   * Which pushdown-relevant pipeline clause a perf finding is about, for the
   * explain-backed rules (operation-not-pushed / operation-pushed-as-script).
   * Drives the "Your query" line so the card names the clause, not just the rule.
   */
  operation?: 'filter' | 'aggregation' | 'sort';
  /** The disabled join keyword detected (e.g. `cross`) for disabled-join-type. */
  joinType?: string;
  /** The unsupported window function name for unsupported-window-function-in-eventstats. */
  windowFunction?: string;
  /** Wildcard counts for replace-wildcard-asymmetry. */
  patternWildcards?: number;
  replacementWildcards?: number;
}
