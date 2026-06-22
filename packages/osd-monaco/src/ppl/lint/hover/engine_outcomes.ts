/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** Static, per-rule hover-card body content, keyed by ruleId. */

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
  'head-without-sort': {
    engineBehavior:
      'head with no preceding sort returns nondeterministic rows: the set depends on shard assignment and segment order, and can change between identical re-runs.',
    failureClass: 'nondeterministic',
    safeToIgnoreWhen:
      'you only need any N rows (a sample), not the top N — and row order does not matter.',
  },
  'division-by-zero': {
    engineBehavior:
      'x / 0 evaluates to null (HTTP 200, result [[null]], type double) with no error — the null then propagates through downstream eval/stats.',
    failureClass: 'silent-null',
    verifiedVersion: '3.7',
    safeToIgnoreWhen:
      'null propagation is intentional and handled downstream (e.g. with coalesce(...)).',
  },
};

/** Look up the static hover content for a ruleId, or undefined when none. */
export function getRuleHoverContent(ruleId: string): RuleHoverContent | undefined {
  return ENGINE_OUTCOMES[ruleId];
}
