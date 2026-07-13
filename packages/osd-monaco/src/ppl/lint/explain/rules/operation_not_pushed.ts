/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../../diagnostic';
import { wholeQueryRange } from '../../range_utils';
import { ExplainDetector } from '../explain_types';
import {
  hasPushDownTag,
  hasRelOp,
  physicalPlanText,
  relTreeContainsCondition,
} from '../explain_tree_utils';

/**
 * A "not pushed" signal: a residual marker that, when present in the physical
 * plan *without* any of its push tags, means the operation fell back to the
 * coordinator after a full fetch.
 */
interface NotPushedSignal {
  /** A residual marker in the legacy plan text. */
  residual: string;
  /** If ANY of these push tags is present, the operation WAS pushed. */
  pushedAs: string[];
  /** Tree-first residual detector for json_tree payloads. */
  hasTreeResidual: (plan: Parameters<ExplainDetector>[0]) => boolean;
  /**
   * Which pipeline clause this signal is about. Rides the diagnostic as
   * `hoverFacts.operation` and `explainTarget.operation` so the hover card can
   * name the clause and the range resolver can find the offending command.
   */
  operation: 'filter' | 'aggregation' | 'sort';
  /**
   * Context-specific message. Leads with the user-visible consequence and names
   * the operation; the engine-internal "why" (coordinator fallback) lives in the
   * hover card's Engine-behavior line, not the inline squiggle.
   */
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
    hasTreeResidual: relTreeContainsCondition,
    operation: 'filter',
    message:
      "This filter can't use the index, so OpenSearch scans every matching row to apply it — slow on large indexes.",
  },
  {
    residual: 'EnumerableAggregate',
    pushedAs: ['AGGREGATION->'],
    hasTreeResidual: (plan) => hasRelOp(plan, 'EnumerableAggregate'),
    operation: 'aggregation',
    message:
      'This aggregation runs in memory over all fetched rows instead of on the data nodes — slow and memory-heavy on large indexes.',
  },
  {
    residual: 'EnumerableSort',
    pushedAs: ['SORT->', 'SORT_EXPR->'],
    hasTreeResidual: (plan) => hasRelOp(plan, 'EnumerableSort'),
    operation: 'sort',
    message:
      'This sort runs after every matching row is fetched, instead of on the index — slow on large result sets.',
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
  const fallbackPhysical = physicalPlanText(plan);
  const diagnostics: Diagnostic[] = [];
  for (const signal of SIGNALS) {
    const hasTreeSignal =
      signal.hasTreeResidual(plan) && !signal.pushedAs.some((tag) => hasPushDownTag(plan, tag));
    const hasTextFallbackSignal =
      fallbackPhysical.includes(signal.residual) &&
      !signal.pushedAs.some((tag) => fallbackPhysical.includes(tag));
    if (hasTreeSignal || hasTextFallbackSignal) {
      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message: signal.message,
        // Whole-query range by default; the tree-aware resolver in the runtime
        // layer narrows this to the offending command via `explainTarget` when a
        // parse tree is available (design §6).
        range: wholeQueryRange(context.query),
        docUrl: config.docUrl,
        hoverFacts: { operation: signal.operation },
        explainTarget: { operation: signal.operation, fields: [] },
      });
    }
  }
  return diagnostics;
};
