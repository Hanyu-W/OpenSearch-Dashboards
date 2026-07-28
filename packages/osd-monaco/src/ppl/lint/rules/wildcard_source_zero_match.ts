/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule } from '../rule_index';
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

function stripSourceQuotes(raw: string): string {
  if (raw.length < 2) {
    return raw;
  }
  const quote = raw[0];
  return quote === raw[raw.length - 1] && (quote === '`' || quote === '"' || quote === "'")
    ? raw.slice(1, -1)
    : raw;
}

function quoteLikeSource(index: string, source: string): string {
  if (source.length < 2 || source[0] !== source[source.length - 1]) {
    return index;
  }
  const quote = source[0];
  if (quote === '`') {
    return `\`${index.replace(/`/g, '``')}\``;
  }
  if (quote === '"' || quote === "'") {
    return `${quote}${index.replace(new RegExp(quote, 'g'), `\\${quote}`)}${quote}`;
  }
  return index;
}

/**
 * Lowest Damerau-Levenshtein distance from `left` to an allowed prefix of
 * `right`. Three rolling rows keep candidate ranking cheap on large index lists.
 */
function prefixEditDistance(left: string, right: string, minRightLength: number): number {
  let twoRowsBack: number[] | undefined;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = new Array<number>(right.length + 1);
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost
      );
      if (twoRowsBack && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        current[j] = Math.min(current[j], twoRowsBack[j - 2] + 1);
      }
    }
    twoRowsBack = previous;
    previous = current;
  }

  let best = Number.POSITIVE_INFINITY;
  for (let length = minRightLength; length < previous.length; length++) {
    best = Math.min(best, previous[length]);
  }
  return best;
}

/**
 * Rank visible indices against the literal prefix before the first wildcard.
 * Only a close match is returned; ties use common-prefix length and then the
 * index name so the same query always receives the same single suggestion.
 */
function mostLikelyIndex(pattern: string, visibleIndices: string[]): string | undefined {
  const literalPrefix = pattern
    .slice(0, pattern.indexOf('*'))
    .replace(/[^a-zA-Z0-9]+$/, '')
    .toLowerCase();
  if (literalPrefix.length < 3) {
    return undefined;
  }

  const maxDistance = Math.min(3, Math.max(1, Math.floor(literalPrefix.length / 3)));
  let best:
    | {
        index: string;
        distance: number;
        commonPrefixLength: number;
      }
    | undefined;

  for (const index of visibleIndices) {
    const lowerIndex = index.toLowerCase();
    const minPrefixLength = Math.max(1, literalPrefix.length - maxDistance);
    const maxPrefixLength = Math.min(lowerIndex.length, literalPrefix.length + maxDistance);
    const distance =
      maxPrefixLength < minPrefixLength
        ? Number.POSITIVE_INFINITY
        : prefixEditDistance(literalPrefix, lowerIndex.slice(0, maxPrefixLength), minPrefixLength);
    if (distance > maxDistance) {
      continue;
    }

    let commonPrefixLength = 0;
    while (
      commonPrefixLength < literalPrefix.length &&
      literalPrefix[commonPrefixLength] === lowerIndex[commonPrefixLength]
    ) {
      commonPrefixLength++;
    }

    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && commonPrefixLength > best.commonPrefixLength) ||
      (distance === best.distance &&
        commonPrefixLength === best.commonPrefixLength &&
        index < best.index)
    ) {
      best = { index, distance, commonPrefixLength };
    }
  }

  return best?.index;
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
      const sourceText = tableSource.getText();
      const pattern = stripSourceQuotes(sourceText);
      if (!pattern.includes('*')) {
        continue; // exact name → nothing (R24.3)
      }
      const matcher = wildcardToRegExp(pattern);
      const matchesAny = visibleIndices.some((index) => matcher.test(index));
      if (!matchesAny) {
        const candidateIndex = mostLikelyIndex(pattern, visibleIndices);
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: `Source pattern "${pattern}" matches no known index.`,
          range: rangeFromContext(tableSource),
          docUrl: config.docUrl,
          hoverFacts: {
            pattern,
            totalIndices: visibleIndices.length,
            ...(candidateIndex ? { candidateIndices: [candidateIndex] } : {}),
          },
          ...(candidateIndex
            ? {
                fix: {
                  title: `Use index "${candidateIndex}"`,
                  text: quoteLikeSource(candidateIndex, sourceText),
                  expectedText: sourceText,
                },
              }
            : {}),
        });
      }
    }
  }

  return diagnostics;
};
