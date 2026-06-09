/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext, TerminalNode } from 'antlr4ng';
import { isTerminalNode } from '../rule_index';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule, findChildByRule, RuleNameToIndex } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth: Join.java:100-101 (highCostJoinTypes = RIGHT/CROSS/FULL)
// and AstBuilder.java:363-369 (validateJoinType). `outer` is an alias for `left`
// and must never be flagged. Fires on all clusters regardless of engine.
const DISABLED_JOIN_KEYWORDS: ReadonlySet<string> = new Set(['right', 'full', 'cross']);

/**
 * Collect the direct terminal token texts (lowercased) of a node.
 */
function directTokenTexts(ctx: ParserRuleContext): string[] {
  const children = ctx.children ?? [];
  return children
    .filter((c): c is TerminalNode => isTerminalNode(c))
    .map((c) => c.getText().toLowerCase());
}

function detectJoinTypeKeyword(
  joinCommand: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): { keyword: string; node: ParserRuleContext } | undefined {
  // Labeled alternatives collapse under ParserInterpreter, so we token-scan
  // (R20.4) two grammar spots:
  //   1. sqlLikeJoinType direct tokens (RIGHT / FULL / CROSS)
  const sqlLikeType = findChildByRule(joinCommand, ruleNameToIndex, 'sqlLikeJoinType');
  if (sqlLikeType) {
    for (const tok of directTokenTexts(sqlLikeType)) {
      if (DISABLED_JOIN_KEYWORDS.has(tok)) {
        return { keyword: tok, node: sqlLikeType };
      }
    }
  }

  //   2. joinOption → TYPE EQUAL joinType
  const joinTypeNodes = findAllDescendantsByRule(joinCommand, ruleNameToIndex, 'joinType');
  for (const joinTypeNode of joinTypeNodes) {
    for (const tok of directTokenTexts(joinTypeNode)) {
      if (DISABLED_JOIN_KEYWORDS.has(tok)) {
        return { keyword: tok, node: joinTypeNode };
      }
    }
  }

  return undefined;
}

export const disabledJoinTypeDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  if (context.settings?.allJoinTypesAllowed === true) {
    return []; // R20.3
  }

  const diagnostics: Diagnostic[] = [];
  const joinCommands = findAllDescendantsByRule(tree, ruleNameToIndex, 'joinCommand');

  for (const joinCommand of joinCommands) {
    const detected = detectJoinTypeKeyword(joinCommand, ruleNameToIndex);
    if (detected) {
      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message: `Join type "${detected.keyword}" is disabled by default (set plugins.calcite.all_join_types.allowed to enable).`,
        range: rangeFromContext(detected.node),
        docUrl: config.docUrl,
      });
    }
  }

  return diagnostics;
};
