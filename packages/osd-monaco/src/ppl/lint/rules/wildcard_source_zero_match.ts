/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule, findChildByRule } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Host index-list check: a wildcard source pattern matching zero visible indices
// is advisory. Self-suppresses without a visible-index list.

/**
 * Convert a PPL wildcard pattern (`*` matches any run of characters) into a
 * RegExp anchored to the full string.
 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

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

export const wildcardSourceZeroMatchDetector: Detector = (
  tree,
  config,
  context,
  ruleNameToIndex
) => {
  const visibleIndices = context.visibleIndices;
  if (!visibleIndices) {
    return []; // R24.4 self-suppress
  }

  const diagnostics: Diagnostic[] = [];

  // searchCommand → fromClause → tableSourceClause → tableSource
  const fromClauses = findAllDescendantsByRule(tree, ruleNameToIndex, 'fromClause');
  for (const fromClause of fromClauses) {
    const tableSources = findAllDescendantsByRule(fromClause, ruleNameToIndex, 'tableSource');
    for (const tableSource of tableSources) {
      const raw = unquote(tableSource.getText());
      if (!raw.includes('*')) {
        continue; // exact name → nothing (R24.3)
      }
      const matcher = wildcardToRegExp(raw);
      const matchesAny = visibleIndices.some((index) => matcher.test(index));
      if (!matchesAny) {
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: `Source pattern "${raw}" matches no known index.`,
          range: rangeFromContext(tableSource),
          docUrl: config.docUrl,
        });
      }
    }
  }

  void findChildByRule;

  return diagnostics;
};
