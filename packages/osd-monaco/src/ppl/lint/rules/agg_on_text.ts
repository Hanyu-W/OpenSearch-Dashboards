/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule, findChildByRule } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth (verified live, OpenSearch 3.7): a numeric aggregation
// (avg/sum/stddev/var/...) on a `text`/`keyword` field returns null with a
// `double` schema type and no error — a silent failure. This is a warning and
// self-suppresses without a typeMap.
//
// Grammar anchor (both surfaces):
//   statsFunction : ... | statsFunctionName LT_PRTHS functionArgs RT_PRTHS  # statsFunctionCall
//   statsFunctionName : AVG | COUNT | SUM | MIN | MAX | VAR_SAMP | VAR_POP
//                     | STDDEV_SAMP | STDDEV_POP | PERCENTILE | PERCENTILE_APPROX | MEDIAN
// `count`/`min`/`max` are type-agnostic and deliberately excluded.

// Aggregations that only produce a meaningful result on a numeric field.
const NUMERIC_ONLY_AGGS: ReadonlySet<string> = new Set([
  'avg',
  'sum',
  'var_samp',
  'var_pop',
  'stddev_samp',
  'stddev_pop',
  'percentile',
  'percentile_approx',
  'median',
]);

// esTypes that hold non-numeric text and so cannot be numerically aggregated.
const TEXT_TYPES: ReadonlySet<string> = new Set(['text', 'keyword']);

export const aggOnTextDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const typeMap = context.typeMap;
  if (!typeMap) {
    return []; // self-suppress without type metadata
  }

  const diagnostics: Diagnostic[] = [];
  const statsFunctions = findAllDescendantsByRule(tree, ruleNameToIndex, 'statsFunction');

  for (const statsFunction of statsFunctions) {
    const nameNode = findChildByRule(statsFunction, ruleNameToIndex, 'statsFunctionName');
    if (!nameNode) {
      continue; // count()/percentile(x,p)/take(...) route through other alternatives
    }
    const aggName = nameNode.getText().toLowerCase();
    if (!NUMERIC_ONLY_AGGS.has(aggName)) {
      continue;
    }

    // Resolve the aggregation argument. Open-world: only flag when the argument
    // is a single bare field (the functionArgs text equals the one field name).
    // A computed argument like `avg(balance / 2)` carries operators and is left
    // alone, mirroring the expand-on-non-array self-suppress pattern.
    const argsNode = findChildByRule(statsFunction, ruleNameToIndex, 'functionArgs');
    if (!argsNode) {
      continue;
    }
    const fieldExprs = findAllDescendantsByRule(argsNode, ruleNameToIndex, 'fieldExpression');
    if (fieldExprs.length !== 1) {
      continue;
    }
    const fieldExpr = fieldExprs[0];
    if (fieldExpr.getText() !== argsNode.getText()) {
      continue; // argument is more than just the bare field
    }

    const esType = typeMap.get(fieldExpr.getText());
    if (esType !== undefined && TEXT_TYPES.has(esType)) {
      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message: `Numeric aggregation "${aggName}" on text field "${fieldExpr.getText()}" returns null rather than a numeric result.`,
        range: rangeFromContext(statsFunction),
        docUrl: config.docUrl,
      });
    }
  }

  return diagnostics;
};
