/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule } from '../rule_index';
import { rangeFromContext, unquote } from '../range_utils';

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

/** Max candidate index names surfaced in the hover card. */
const MAX_CANDIDATES = 5;

/**
 * Pick up to {@link MAX_CANDIDATES} visible indices whose name starts with the
 * pattern's leading literal run (the text before its first `*`). This is the
 * "did you mean" set — e.g. `logs-*` surfaces `logs_2024`, `logs_2025`. Cheap:
 * one prefix check per visible index, computed once at emit time (the rule
 * already fired, so this runs only on the rare zero-match path).
 */
function nearbyCandidates(pattern: string, visibleIndices: string[]): string[] {
  const literalPrefix = pattern.slice(0, pattern.indexOf('*')).replace(/[^a-zA-Z0-9]+$/, '');
  // A 1-char prefix is too weak to be a useful hint; require at least 2.
  if (literalPrefix.length < 2) {
    return [];
  }
  const lower = literalPrefix.toLowerCase();
  const out: string[] = [];
  for (const index of visibleIndices) {
    // Prefix match (not substring): `logs` should surface `logs_2024`, not an
    // unrelated `applogs_archive`.
    if (index.toLowerCase().startsWith(lower)) {
      out.push(index);
      if (out.length === MAX_CANDIDATES) {
        break;
      }
    }
  }
  return out;
}

export const wildcardSourceZeroMatchDetector: Detector = (
  tree,
  config,
  context,
  ruleNameToIndex
) => {
  const visibleIndices = context.visibleIndices;
  // Self-suppress when the visible-index list is absent OR empty: an empty list
  // is "we don't know what's visible", not "every pattern matches nothing".
  // Without this, every wildcard source would false-fire "matched 0 of 0".
  if (!visibleIndices || visibleIndices.length === 0) {
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
        const candidateIndices = nearbyCandidates(raw, visibleIndices);
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: `Source pattern "${raw}" matches no known index.`,
          range: rangeFromContext(tableSource),
          docUrl: config.docUrl,
          hoverFacts: {
            pattern: raw,
            totalIndices: visibleIndices.length,
            ...(candidateIndices.length > 0 ? { candidateIndices } : {}),
          },
        });
      }
    }
  }

  return diagnostics;
};
