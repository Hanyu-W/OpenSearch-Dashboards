/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule, isRuleNode, isTerminalNode } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth (verified live, OpenSearch 3.7): `field / 0` and `5 / 0`
// evaluate to null (HTTP 200, `[[null]]`, schema type `double`) with no error —
// a silent failure, consistent with SQL NULL semantics. This is advisory
// (warning) and naturally scoped to literal-zero denominators; a variable
// denominator like `field/(a-b)` is left undetected.
//
// Grammar anchor (both surfaces):
//   valueExpression
//     : left=valueExpression binaryOperator=(STAR|DIVIDE|MODULE) right=valueExpression  # binaryArithmetic
// The DIVIDE operator is a direct terminal child of the `valueExpression` node;
// the divisor is the rule-node sibling that follows it.

// Only flag `/`. Modulo-by-zero was not verified live, and STAR/PLUS/MINUS are
// not division. Keeping to the verified operator preserves the zero-noise bar.
const DIVISION_OPERATOR = '/';

/**
 * Is `raw` a numeric literal that equals zero? Strips matched surrounding
 * parentheses and an optional sign, then requires a plain decimal literal whose
 * numeric value is zero. Matches `0`, `00`, `0.0`, `.0`, `(0)`, `-0`; rejects
 * field names, non-zero numbers, and computed expressions.
 */
function isZeroLiteral(raw: string): boolean {
  let text = raw.trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('+') || text.startsWith('-')) {
    text = text.slice(1).trim();
  }
  if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(text)) {
    return false;
  }
  return Number(text) === 0;
}

export const divisionByZeroDetector: Detector = (tree, config, _context, ruleNameToIndex) => {
  const diagnostics: Diagnostic[] = [];
  const valueExpressions = findAllDescendantsByRule(tree, ruleNameToIndex, 'valueExpression');

  for (const node of valueExpressions) {
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!isTerminalNode(child) || child.getText() !== DIVISION_OPERATOR) {
        continue;
      }
      // The divisor is the first rule-node sibling after the operator.
      const divisor = children.slice(i + 1).find(isRuleNode);
      if (divisor && isZeroLiteral(divisor.getText())) {
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: 'Division by literal zero evaluates to null rather than raising an error.',
          range: rangeFromContext(divisor),
          docUrl: config.docUrl,
        });
      }
    }
  }

  return diagnostics;
};
