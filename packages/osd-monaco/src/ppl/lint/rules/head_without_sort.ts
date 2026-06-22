/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { buildPipelineShape, collectAlternateSourceSubtrees } from '../pipeline_shape';
import { rangeFromContext } from '../range_utils';

// Advisory (no engine throw): a `head` with no preceding `sort` in the pipeline
// returns nondeterministic rows.

export const headWithoutSortDetector: Detector = (tree, config, _context, ruleNameToIndex) => {
  const diagnostics: Diagnostic[] = [];
  const { stages } = buildPipelineShape(tree, ruleNameToIndex);

  // A sort inside a join/subsearch subquery does not order the outer pipeline,
  // so it must not satisfy the outer head. Drop stages under an alternate-source
  // subtree before scanning (mirrors detectUnknownFields' pruning) (B7).
  const altRoots = collectAlternateSourceSubtrees(tree, ruleNameToIndex);
  const isInsideAltSource = (node: ParserRuleContext): boolean => {
    for (let n: ParserRuleContext | null = node; n; n = n.parent as ParserRuleContext | null) {
      if (altRoots.has(n)) {
        return true;
      }
    }
    return false;
  };

  let sawSort = false;
  for (const stage of stages) {
    if (isInsideAltSource(stage.node)) {
      continue;
    }
    if (stage.command === 'sortCommand') {
      sawSort = true;
      continue;
    }
    if (stage.command === 'headCommand') {
      if (!sawSort) {
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: 'head without a preceding sort returns nondeterministic rows.',
          range: rangeFromContext(stage.node),
          docUrl: config.docUrl,
        });
      }
    }
  }

  return diagnostics;
};
