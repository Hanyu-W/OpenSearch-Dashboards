/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule, findChildByRule } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Ground truth (#5065): OpenSearch has no literal `array` esType; arrays are
// represented by `nested`/`object` mapping types and the codegen path can
// succeed, so this is a warning. Self-suppresses without a typeMap.
const ARRAY_LIKE_TYPES: ReadonlySet<string> = new Set(['nested', 'object']);

export const expandOnNonArrayDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const typeMap = context.typeMap;
  if (!typeMap) {
    return []; // R23.3 self-suppress
  }

  const diagnostics: Diagnostic[] = [];
  const commands = findAllDescendantsByRule(tree, ruleNameToIndex, 'expandCommand');

  for (const command of commands) {
    const fieldExpr = findChildByRule(command, ruleNameToIndex, 'fieldExpression');
    if (!fieldExpr) {
      continue;
    }
    const fieldName = fieldExpr.getText();
    const esType = typeMap.get(fieldName);
    // Only flag when we know the type and it is not array-like.
    if (esType !== undefined && !ARRAY_LIKE_TYPES.has(esType)) {
      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message: `expand target "${fieldName}" has type "${esType}", which is not an array/nested/object type.`,
        range: rangeFromContext(fieldExpr),
        docUrl: config.docUrl,
      });
    }
  }

  return diagnostics;
};
