/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllChildrenByRule, findAllDescendantsByRule, RuleNameToIndex } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth: CalciteRelNodeVisitor.visitReplace throws
// IllegalArgumentException (WildcardUtils.validateWildcardSymmetry) when the
// replacement wildcard count differs from the pattern count and is non-zero.
// Not caught by the Calcite-to-v2 fallback (default plugins.calcite.fallback.allowed=false).
// `replace` is Calcite-only and runtime-only.

/**
 * Count unescaped `*` occurrences in a string, excluding `\*`.
 */
function countUnescapedWildcards(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '*') {
      // Count preceding backslashes; an odd number means the `*` is escaped.
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && text[j] === '\\') {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Strip surrounding quotes from a string-literal token text.
 */
function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

export const replaceWildcardAsymmetryDetector: Detector = (
  tree,
  config,
  context,
  ruleNameToIndex
) => {
  // Runtime-only + Calcite-gated. `replacePair` is absent on the compiled
  // surface → findAllDescendantsByRule returns [] → clean no-op.
  if (context.isCalcite !== true) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const pairs = findAllDescendantsByRule(tree, ruleNameToIndex, 'replacePair');

  for (const pair of pairs) {
    const literals = findAllChildrenByRule(pair, ruleNameToIndex, 'stringLiteral');
    if (literals.length < 2) {
      continue;
    }
    const patternText = unquote(literals[0].getText());
    const replacementText = unquote(literals[1].getText());
    const patternCount = countUnescapedWildcards(patternText);
    const replacementCount = countUnescapedWildcards(replacementText);

    if (replacementCount !== 0 && replacementCount !== patternCount) {
      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message: `replace wildcard counts are asymmetric: pattern has ${patternCount}, replacement has ${replacementCount}.`,
        range: rangeFromContext(pair),
        docUrl: config.docUrl,
      });
    }
  }

  return diagnostics;
};
