/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule, isRuleNode, RuleNameToIndex } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth (verified live, OpenSearch 3.7): comparing a numeric field
// to a NON-coercible string literal (e.g. `age = "thirty"`) returns 0 rows with
// HTTP 200 and no error — a silent failure. (A coercible quoted number like
// `age = "32"` works correctly and must NOT be flagged; this rule fires only on
// the string-literal-vs-numeric-field equality form.) Warning severity;
// self-suppresses without a typeMap.
//
// SCOPE: this is deliberately the narrow literal-vs-field form. The general
// type-mismatch case (computed expressions, field-vs-field) requires dataflow
// tracking and remains deferred.
//
// Grammar anchor (both surfaces): an equality comparison parses to an
// `expression` whose children are [leftExpression, comparisonOperator,
// rightExpression]. `comparisonOperator` exists on BOTH the compiled simplified
// grammar and the runtime grammar, so this detector keys on it rather than on
// the runtime-only `comparisonExpression` rule.

// Equality/inequality operators only — the silent failure is the `=` term-query
// path. Range operators are intentionally excluded to hold the zero-FP bar.
const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(['=', '==', '!=', '<>']);

const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  'integer',
  'long',
  'float',
  'double',
  'short',
  'byte',
  'half_float',
  'scaled_float',
  'unsigned_long',
]);

/** Is this operand a bare string literal (e.g. `"thirty"`), not a computed expr? */
function asStringLiteral(operand: ParserRuleContext, ruleNameToIndex: RuleNameToIndex): boolean {
  const text = operand.getText();
  if (text.length < 2) {
    return false;
  }
  const first = text[0];
  const last = text[text.length - 1];
  const quoted = (first === '"' && last === '"') || (first === "'" && last === "'");
  if (!quoted) {
    return false;
  }
  // Confirm the operand actually wraps a stringLiteral node spanning its whole
  // text (rejects things like `"a" + "b"` which also start/end with a quote).
  const literals = findAllDescendantsByRule(operand, ruleNameToIndex, 'stringLiteral');
  return literals.some((lit) => lit.getText() === text);
}

/**
 * If this operand is a bare field reference, return its name; otherwise
 * undefined. A computed operand (more than the field name) is rejected.
 */
function asBareField(
  operand: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): string | undefined {
  const fields = findAllDescendantsByRule(operand, ruleNameToIndex, 'fieldExpression');
  if (fields.length !== 1) {
    return undefined;
  }
  const name = fields[0].getText();
  return name === operand.getText() ? name : undefined;
}

export const typeMismatchNumericDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const typeMap = context.typeMap;
  if (!typeMap) {
    return []; // self-suppress without type metadata
  }

  const diagnostics: Diagnostic[] = [];
  const operators = findAllDescendantsByRule(tree, ruleNameToIndex, 'comparisonOperator');

  for (const operator of operators) {
    if (!EQUALITY_OPERATORS.has(operator.getText())) {
      continue;
    }
    const parent = operator.parent;
    if (!isRuleNode(parent)) {
      continue;
    }
    // The operands are the rule-node children flanking the operator. The
    // `comparisonOperator` is itself a rule node, so exclude it explicitly.
    const operands = (parent.children ?? []).filter(
      (c): c is ParserRuleContext => isRuleNode(c) && c !== operator
    );
    if (operands.length !== 2) {
      continue;
    }
    const [left, right] = operands;

    // One side must be a bare numeric field, the other a bare string literal.
    let fieldName: string | undefined;
    let literalSide: ParserRuleContext | undefined;
    if (asStringLiteral(right, ruleNameToIndex)) {
      fieldName = asBareField(left, ruleNameToIndex);
      literalSide = right;
    } else if (asStringLiteral(left, ruleNameToIndex)) {
      fieldName = asBareField(right, ruleNameToIndex);
      literalSide = left;
    }

    if (fieldName === undefined || literalSide === undefined) {
      continue;
    }
    const esType = typeMap.get(fieldName);
    if (esType === undefined || !NUMERIC_TYPES.has(esType)) {
      continue;
    }
    // The engine coerces quoted *numeric* strings correctly (e.g. "32"); only a
    // non-numeric string literal is a silent failure.
    const literalText = literalSide.getText().slice(1, -1);
    if (literalText.trim() !== '' && !Number.isNaN(Number(literalText))) {
      continue;
    }

    diagnostics.push({
      ruleId: config.id,
      severity: config.severity,
      message: `Comparing numeric field "${fieldName}" (${esType}) to non-numeric string ${literalSide.getText()} matches no documents (returns 0 rows, no error).`,
      range: rangeFromContext(parent),
      docUrl: config.docUrl,
      hoverFacts: { field: fieldName, esType, literal: literalSide.getText() },
    });
  }

  return diagnostics;
};
