/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllChildrenByRule, findAllDescendantsByRule } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth: multisearch with fewer than two subsearches throws
// "Multisearch command requires at least two subsearches" (AstBuilder.java:1347),
// at AST-build time (engine-independent). Runtime-only, minVersion 3.4.0.

export const multisearchMinSubsearchDetector: Detector = (
  tree,
  config,
  _context,
  ruleNameToIndex
) => {
  const diagnostics: Diagnostic[] = [];
  // `multisearchCommand` is runtime-only; absent on the compiled surface → [].
  const commands = findAllDescendantsByRule(tree, ruleNameToIndex, 'multisearchCommand');

  for (const command of commands) {
    const subSearches = findAllChildrenByRule(command, ruleNameToIndex, 'subSearch');
    if (subSearches.length < 2) {
      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message: 'multisearch requires at least two subsearches.',
        range: rangeFromContext(command),
        docUrl: config.docUrl,
      });
    }
  }

  return diagnostics;
};
