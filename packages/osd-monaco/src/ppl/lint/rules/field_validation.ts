/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext, ParseTree } from 'antlr4ng';
import { isRuleNode } from '../rule_index';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { buildPipelineShape } from '../pipeline_shape';
import { isParserRuleContext, RuleNameToIndex } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Schema check: a field reference is unknown when it is not in the union of
// index fields and fields created upstream. Self-suppresses without context.

/**
 * Compute a small set of rule indices used to exclude non-field-reference
 * positions (table sources, eval LHS, etc.).
 */
function resolveExcludedAncestorIndices(ruleNameToIndex: RuleNameToIndex): Set<number> {
  const excluded = new Set<number>();
  for (const name of [
    'fromClause',
    'tableSource',
    'tableSourceClause',
    'tableQualifiedName',
    'sourceReference',
    'sideAlias',
    'evalClause',
    'renameClasue',
  ]) {
    const idx = ruleNameToIndex(name);
    if (idx !== -1) {
      excluded.add(idx);
    }
  }
  return excluded;
}

function hasExcludedAncestor(node: ParserRuleContext, excludedIndices: Set<number>): boolean {
  let current: ParseTree | null = node.parent;
  while (current) {
    if (isRuleNode(current) && excludedIndices.has(current.ruleIndex)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Levenshtein distance with an early-out: once every cell in a row exceeds
 * `maxDistance`, no later row can drop back below it, so we abort and return a
 * value `> maxDistance` to signal "too far". Bounding the work keeps the
 * per-keystroke field-suggestion sweep cheap on wide indices.
 */
function levenshtein(a: string, b: string, maxDistance: number): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function suggestField(name: string, known: Iterable<string>): string | undefined {
  // Only suggest when reasonably close (≤ 1/3 of the name length, min 2).
  const threshold = Math.max(2, Math.floor(name.length / 3));
  const lowerName = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    // A length gap alone larger than the threshold guarantees distance >
    // threshold, so skip the DP entirely for those candidates.
    if (Math.abs(candidate.length - name.length) > threshold) {
      continue;
    }
    const distance = levenshtein(lowerName, candidate.toLowerCase(), threshold);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      if (bestDistance === 1) {
        break; // Nothing closer is worth finding for a suggestion.
      }
    }
  }
  return best && bestDistance <= threshold ? best : undefined;
}

export const fieldValidationDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const fields = context.fields;
  if (!fields || fields.size === 0) {
    return []; // R22.3 self-suppress
  }

  const { createdFields } = buildPipelineShape(tree, ruleNameToIndex);
  const known = new Set<string>([...fields, ...createdFields]);
  const excludedIndices = resolveExcludedAncestorIndices(ruleNameToIndex);
  const fieldExprIdx = ruleNameToIndex('fieldExpression');
  if (fieldExprIdx === -1) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();

  const stack: ParseTree[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!isParserRuleContext(node)) {
      continue;
    }
    if (node.ruleIndex === fieldExprIdx) {
      const name = node.getText();
      // Dot-qualified references: validate only the leaf for join contexts is
      // complex; v1 validates the full text and the leading segment.
      const leaf = name.includes('.') ? name.split('.')[0] : name;
      if (
        name &&
        !hasExcludedAncestor(node, excludedIndices) &&
        !known.has(name) &&
        !known.has(leaf) &&
        !seen.has(name)
      ) {
        seen.add(name);
        const suggestion = suggestField(name, known);
        const suffix = suggestion ? ` Did you mean "${suggestion}"?` : '';
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: `Unknown field "${name}".${suffix}`,
          range: rangeFromContext(node),
          docUrl: config.docUrl,
          // The diagnostic range spans exactly the field reference, so the fix
          // replaces it in place (no explicit fix range needed).
          ...(suggestion
            ? { fix: { title: `Replace with "${suggestion}"`, text: suggestion } }
            : {}),
        });
      }
    }
    stack.push(...(node.children ?? []));
  }

  return diagnostics;
};
