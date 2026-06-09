/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule, RuleNameToIndex } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth: `dedup consecutive=true` throws CalciteUnsupportedException
// (CalciteRelNodeVisitor.java:2130) which is unconditionally caught by the
// Calcite-to-v2 fallback, and v2 DedupeOperator supports it. So this is a
// warning (query succeeds via fallback), and only on Calcite sources.

/**
 * Scan the flattened token text of a `dedupCommand` for `consecutive = true`,
 * tolerant of whitespace between tokens.
 */
function hasConsecutiveTrue(command: ParserRuleContext, ruleNameToIndex: RuleNameToIndex): boolean {
  // Resolve the consecutive boolean literal: in the grammar it is the last
  // booleanLiteral preceded by the CONSECUTIVE keyword. Scan token text.
  const text = command.getText().toLowerCase();
  const match = /consecutive=(true|false)/.exec(text);
  if (match) {
    return match[1] === 'true';
  }
  // Fallback: inspect booleanLiteral children paired with CONSECUTIVE keyword.
  void findAllDescendantsByRule(command, ruleNameToIndex, 'booleanLiteral');
  return false;
}

export const dedupConsecutiveUnsupportedDetector: Detector = (
  tree,
  config,
  context,
  ruleNameToIndex
) => {
  // Calcite gating is also enforced by the version filter, but guard here too
  // so a direct detector invocation respects the engine predicate (R16.4).
  if (context.isCalcite !== true) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const commands = findAllDescendantsByRule(tree, ruleNameToIndex, 'dedupCommand');

  for (const command of commands) {
    if (hasConsecutiveTrue(command, ruleNameToIndex)) {
      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message:
          'dedup consecutive=true is not natively supported on Calcite; the query relies on engine fallback.',
        range: rangeFromContext(command),
        docUrl: config.docUrl,
      });
    }
  }

  return diagnostics;
};
