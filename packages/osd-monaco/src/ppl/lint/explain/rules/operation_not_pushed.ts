/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../../diagnostic';
import { wholeQueryRange } from '../../range_utils';
import { ExplainDetector } from '../explain_types';

/**
 * A "not pushed" signal: a residual marker that, when present in the physical
 * plan *without* any of its push tags, means the operation fell back to the
 * coordinator after a full fetch.
 */
interface NotPushedSignal {
  /** A residual marker in the plan text (Enumerable node or `$condition=`). */
  residual: string;
  /** If ANY of these push tags is present, the operation WAS pushed. */
  pushedAs: string[];
  /** Context-specific message so the user knows which operation to fix. */
  message: string;
}

// Match on operator presence/absence, never on expression formatting — the
// `PushDownContext.toString()` shape is not a stable API (see design §8). The
// `$condition=` filter signal uses a bare substring match rather than a regex
// because the condition node can wrap nested parens (e.g. `$condition=[$t5]`
// where `$t5` is `CAST($t2):DOUBLE NOT NULL`), which truncates a `[^)]*` regex.
const SIGNALS: NotPushedSignal[] = [
  {
    residual: '$condition=',
    pushedAs: ['FILTER->', 'SCRIPT->'],
    message:
      'A filter in this query could not be pushed to OpenSearch and runs in the coordinator after a full index scan. Consider rewriting to avoid arithmetic or functions in the predicate.',
  },
  {
    residual: 'EnumerableAggregate',
    pushedAs: ['AGGREGATION->'],
    message:
      'An aggregation in this query could not be pushed to OpenSearch and runs in the coordinator. An unsupported function or expression may be forcing in-engine aggregation.',
  },
  {
    residual: 'EnumerableSort',
    pushedAs: ['SORT->', 'SORT_EXPR->'],
    message:
      'A sort in this query could not be pushed to OpenSearch and runs in the coordinator after fetching all matching rows.',
  },
];

/**
 * Flags operations the optimizer left running in the coordinator. Adding
 * coverage for a future operation type (e.g. a join) means appending one entry
 * to {@link SIGNALS} — no new rule, no new catalog entry.
 */
export const operationNotPushedDetector: ExplainDetector = (plan, config, context) => {
  if (!plan.isCalcite) {
    return [];
  }
  const physical = plan.physical;
  const diagnostics: Diagnostic[] = [];
  for (const signal of SIGNALS) {
    if (
      physical.includes(signal.residual) &&
      !signal.pushedAs.some((tag) => physical.includes(tag))
    ) {
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
