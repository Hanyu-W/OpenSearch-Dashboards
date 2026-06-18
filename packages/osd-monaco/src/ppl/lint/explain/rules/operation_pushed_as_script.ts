/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../../diagnostic';
import { wholeQueryRange } from '../../range_utils';
import { ExplainDetector } from '../explain_types';

/**
 * A "pushed as script" signal: an operation that WAS pushed into OpenSearch, but
 * via a Painless script — per-document evaluation instead of a native query or
 * sort.
 */
interface ScriptSignal {
  /** The PushDownContext tag that indicates script execution. */
  pushTag: string;
  /** Must ALSO be present to confirm a real script push (guards false positives). */
  discriminator: string;
  /** Context-specific message so the user knows which operation to fix. */
  message: string;
}

// Both the push tag AND the discriminator must be present. The discriminator
// alone is not enough: a pushed composite aggregation can carry a script-based
// group key (`opensearch_compounded_script` inside the bucket source) without
// any `SCRIPT->`/`SORT_EXPR->` tag — requiring the tag prevents a false positive
// on that pushed-aggregation case (design §6.10 finding 3).
const SIGNALS: ScriptSignal[] = [
  {
    pushTag: 'SCRIPT->',
    discriminator: 'opensearch_compounded_script',
    message:
      'A filter in this query was pushed as a Painless script, meaning every document is evaluated by a script instead of a native index lookup. Consider simplifying the predicate to use direct field comparisons.',
  },
  {
    pushTag: 'SORT_EXPR->',
    discriminator: 'opensearch_compounded_script',
    message:
      'A sort in this query was pushed as a Painless script sort. Every matching document will be scored by a script. Consider sorting on a stored field or a pre-computed value.',
  },
];

/**
 * Flags operations pushed into OpenSearch as Painless scripts. Mutually
 * exclusive with `operation-not-pushed` for any given operation signal: either
 * the operation was not pushed (that rule) or it was pushed expensively (this
 * rule), never both.
 */
export const operationPushedAsScriptDetector: ExplainDetector = (plan, config, context) => {
  if (!plan.isCalcite) {
    return [];
  }
  const physical = plan.physical;
  const diagnostics: Diagnostic[] = [];
  for (const signal of SIGNALS) {
    if (physical.includes(signal.pushTag) && physical.includes(signal.discriminator)) {
      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message: signal.message,
        range: wholeQueryRange(context.query),
        docUrl: config.docUrl,
      });
    }
  }
  return diagnostics;
};
