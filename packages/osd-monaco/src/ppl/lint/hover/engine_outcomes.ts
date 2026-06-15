/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Static, per-rule body content for the lint hover card ("view more"). Keyed by
 * ruleId — the value that rides every marker as `code.value` and survives
 * Monaco's MarkerService rebuild (see `fix_registry.ts`). The hover provider
 * looks an entry up by `code.value` with an O(1) map read; there is no per-lint
 * cost and no network.
 *
 * Each `engineBehavior` sentence is condensed from the detector's verified
 * "Engine ground truth" docblock (the same source the rule's severity is
 * justified by), so the card is a rendering of knowledge the rule already
 * encodes rather than a new place to invent claims. When a rule is added, add
 * its entry here; `engine_outcomes.test.ts` fails until catalog and table agree.
 */

/**
 * The runtime outcome class a rule flags. Drives the "Why <severity>" line and a
 * glyph in the rendered card.
 *  - `silent-null`      — query succeeds (HTTP 200) but a value resolves to null.
 *  - `silent-empty`     — query succeeds (HTTP 200) but matches zero rows.
 *  - `engine-throw`     — engine rejects the query (e.g. HTTP 400 / exception).
 *  - `nondeterministic` — query succeeds but the result set is not stable.
 *  - `fallback`         — primary engine can't run it; a fallback engine does.
 *  - `advisory`         — query runs and may return data, but the command can
 *                         silently behave differently than intended on this
 *                         input; the check is a heads-up, not a hard outcome.
 */
export type FailureClass =
  | 'silent-null'
  | 'silent-empty'
  | 'engine-throw'
  | 'nondeterministic'
  | 'fallback'
  | 'advisory';

export interface RuleHoverContent {
  /** One precise sentence: what the engine does at runtime. */
  engineBehavior: string;
  failureClass: FailureClass;
  /**
   * Optional escape hatch describing the condition under which the finding does
   * not matter. The hover card chooses its label from {@link failureClass}: for
   * `engine-throw` rules it renders as "Possible false positive" (the engine
   * *would* reject the query, so the only reason to dismiss the warning is that
   * the linter is being conservative); for the runs-anyway classes it renders as
   * "Safe to ignore". MUST be absent for error-severity rules (asserted by
   * `engine_outcomes.test.ts`): an error is never dismissible.
   */
  safeToIgnoreWhen?: string;
  /** OpenSearch version the behavior was verified on, when the docblock states it. */
  verifiedVersion?: string;
}

export const ENGINE_OUTCOMES: Record<string, RuleHoverContent> = {
  'invalid-capture-group-name': {
    engineBehavior:
      'rex capture-group names must match the Java group-name rule; underscores and leading digits are rejected when the regex runs.',
    failureClass: 'engine-throw',
  },
  'unsupported-window-function-in-eventstats': {
    engineBehavior:
      'Only row_number is a valid window function; first/last are aggregation-only and are rejected in eventstats/streamstats.',
    failureClass: 'engine-throw',
  },
  'dedup-consecutive-unsupported': {
    engineBehavior:
      'On the Calcite engine, dedup consecutive=true throws CalciteUnsupportedException, which the Calcite-to-v2 fallback unconditionally catches; v2 then runs it. The query succeeds via the slower fallback path.',
    failureClass: 'fallback',
    safeToIgnoreWhen:
      'your cluster has the Calcite-to-v2 fallback enabled and tested — the query runs, just on the fallback path.',
  },
  'replace-wildcard-asymmetry': {
    engineBehavior:
      'On the Calcite engine (replace is Calcite-only), the engine throws IllegalArgumentException when the replacement wildcard count differs from the pattern count and is non-zero. This is NOT caught by the fallback.',
    failureClass: 'engine-throw',
  },
  'union-min-datasets': {
    engineBehavior:
      'union with fewer than two datasets throws "Union command requires at least two datasets".',
    failureClass: 'engine-throw',
  },
  'multisearch-min-subsearch': {
    engineBehavior:
      'multisearch with fewer than two subsearches throws "Multisearch command requires at least two subsearches" while the query is parsed, on every engine.',
    failureClass: 'engine-throw',
  },
  'disabled-join-type': {
    engineBehavior:
      'right, cross, and full joins are high-cost and disabled by default, so the engine rejects them. (outer is an alias for left and is never flagged.)',
    failureClass: 'engine-throw',
    safeToIgnoreWhen:
      'the cluster has all join types explicitly allowed — then the join runs as written.',
  },
  'head-without-sort': {
    engineBehavior:
      'head with no preceding sort returns nondeterministic rows: the set depends on shard assignment and segment order, and can change between identical re-runs.',
    failureClass: 'nondeterministic',
    safeToIgnoreWhen:
      'you only need any N rows (a sample), not the top N — and row order does not matter.',
  },
  'field-validation': {
    engineBehavior:
      'the field is not present in the index and is not created upstream in the pipeline, so the engine cannot resolve it.',
    failureClass: 'engine-throw',
    safeToIgnoreWhen:
      'the field is produced by an upstream eval/rename the linter cannot see (it does not track every dataflow).',
  },
  'expand-on-non-array': {
    engineBehavior:
      'OpenSearch has no literal array type — arrays are stored as nested/object — so the codegen path can succeed; this is advisory.',
    failureClass: 'advisory',
    safeToIgnoreWhen: 'the field really is a nested/object array shape at query time.',
  },
  'wildcard-source-zero-match': {
    engineBehavior:
      'a source= wildcard pattern matching zero visible indices returns no data; this is an advisory host-side check against the visible index list.',
    failureClass: 'silent-empty',
    safeToIgnoreWhen:
      'the matching index will exist when the query runs but is not visible right now.',
  },
  'division-by-zero': {
    engineBehavior:
      'x / 0 evaluates to null (HTTP 200, result [[null]], type double) with no error — the null then propagates through downstream eval/stats.',
    failureClass: 'silent-null',
    verifiedVersion: '3.7',
    safeToIgnoreWhen:
      'null propagation is intentional and handled downstream (e.g. with coalesce(...)).',
  },
  'agg-on-text': {
    engineBehavior:
      'a numeric aggregation (avg/sum/stddev/var/...) on a text or keyword field returns null with a double schema type and no error. count/min/max are unaffected.',
    failureClass: 'silent-null',
    verifiedVersion: '3.7',
    safeToIgnoreWhen:
      'the field holds numeric strings and you will cast it, or you intend a non-numeric aggregation.',
  },
  'flat-object-subfield': {
    engineBehavior:
      'referencing a subfield of a flat_object field raises IllegalArgumentException: Field [...] not found (HTTP 400) — the query is rejected before any rows return.',
    failureClass: 'engine-throw',
    verifiedVersion: '3.7',
  },
  'type-mismatch-numeric': {
    engineBehavior:
      'comparing a numeric field to a non-coercible string literal (e.g. age = "thirty") matches zero rows (HTTP 200, no error). A coercible numeric string like "32" works correctly.',
    failureClass: 'silent-empty',
    verifiedVersion: '3.7',
  },
  'enabled-false-object': {
    engineBehavior:
      'a field inside an object mapped enabled:false is stored but not indexed, so references resolve to null (type undefined, HTTP 200) — never the stored value.',
    failureClass: 'silent-null',
    verifiedVersion: '3.7',
    safeToIgnoreWhen:
      'you only read the field from _source after fetch, never filtering/aggregating/sorting on it.',
  },
};

/** Look up the static hover content for a ruleId, or undefined when none. */
export function getRuleHoverContent(ruleId: string): RuleHoverContent | undefined {
  return ENGINE_OUTCOMES[ruleId];
}
