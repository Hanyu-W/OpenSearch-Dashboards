/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CharStream, CommonTokenStream, ParserRuleContext } from 'antlr4ng';
import { OpenSearchPPLLexer, OpenSearchPPLParser } from '@osd/antlr-grammar';
import { resolveExplainRanges } from '../resolve_explain_ranges';
import { createRuntimeRuleNameToIndex } from '../../rule_index';
import { Diagnostic } from '../../diagnostic';
import { wholeQueryRange } from '../../range_utils';

// The full compiled grammar shares rule names with the runtime bundle for the
// commands the resolver walks (whereCommand / statsCommand / sortCommand and the
// field-bearing sub-rules), so its rule-name->index map stands in for the
// runtime map — the same proxy field_slot_shape.test.ts uses.
const ruleNameToIndex = createRuntimeRuleNameToIndex(
  new Map(OpenSearchPPLParser.ruleNames.map((name, idx) => [name, idx]))
);

function buildTree(query: string): ParserRuleContext {
  const lexer = new OpenSearchPPLLexer(CharStream.fromString(query));
  lexer.removeErrorListeners();
  const parser = new OpenSearchPPLParser(new CommonTokenStream(lexer));
  parser.removeErrorListeners();
  return parser.root();
}

function explainDiag(
  operation: 'filter' | 'aggregation' | 'sort',
  query: string,
  fields: string[] = []
): Diagnostic {
  return {
    ruleId: 'operation-not-pushed',
    severity: 'warning',
    message: 'slow',
    range: wholeQueryRange(query),
    explainTarget: { operation, fields },
  };
}

/** The substring of `query` a range covers (single-line queries only here). */
function slice(query: string, d: Diagnostic): string {
  return query.slice(d.range.startColumn, d.range.endColumn);
}

describe('resolveExplainRanges', () => {
  it('narrows a filter finding to the where expression, not the whole query', () => {
    const query = 'source=accounts | where balance / 100 > 200';
    const tree = buildTree(query);
    const [resolved] = resolveExplainRanges([explainDiag('filter', query)], tree, ruleNameToIndex);

    // No longer the whole query.
    expect(resolved.range.startColumn).toBeGreaterThan(0);
    // Lands on the predicate expression.
    expect(slice(query, resolved)).toContain('balance / 100 > 200');
    expect(slice(query, resolved)).not.toContain('source=accounts');
  });

  it('narrows a sort finding to the sort clause', () => {
    const query = 'source=accounts | sort balance';
    const tree = buildTree(query);
    const [resolved] = resolveExplainRanges([explainDiag('sort', query)], tree, ruleNameToIndex);

    expect(resolved.range.startColumn).toBeGreaterThan(0);
    expect(slice(query, resolved)).toContain('balance');
    expect(slice(query, resolved)).not.toContain('source=accounts');
  });

  it('narrows an aggregation finding to the stats term', () => {
    const query = 'source=accounts | stats avg(balance) by state';
    const tree = buildTree(query);
    const [resolved] = resolveExplainRanges(
      [explainDiag('aggregation', query)],
      tree,
      ruleNameToIndex
    );

    expect(resolved.range.startColumn).toBeGreaterThan(0);
    expect(slice(query, resolved)).toContain('avg(balance)');
  });

  it('keeps the whole-query range when several matching commands cannot be disambiguated', () => {
    const query = 'source=accounts | where age > 1 | where balance > 2';
    const tree = buildTree(query);
    const original = explainDiag('filter', query); // no fields → ambiguous
    const [resolved] = resolveExplainRanges([original], tree, ruleNameToIndex);

    expect(resolved.range).toEqual(original.range);
  });

  it('disambiguates by field overlap when the plan named the fields', () => {
    const query = 'source=accounts | where age > 1 | where balance > 2';
    const tree = buildTree(query);
    const [resolved] = resolveExplainRanges(
      [explainDiag('filter', query, ['balance'])],
      tree,
      ruleNameToIndex
    );

    expect(slice(query, resolved)).toContain('balance > 2');
    expect(slice(query, resolved)).not.toContain('age > 1');
  });

  it('leaves a diagnostic without an explainTarget untouched', () => {
    const query = 'source=accounts | where balance > 2';
    const tree = buildTree(query);
    const plain: Diagnostic = {
      ruleId: 'field-validation',
      severity: 'error',
      message: 'unknown field',
      range: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 9 },
    };
    const [resolved] = resolveExplainRanges([plain], tree, ruleNameToIndex);
    expect(resolved).toBe(plain);
  });

  it('falls back to the whole-query range when the operation has no matching command', () => {
    // A sort finding but the query has no sort command (mismatched plan/tree).
    const query = 'source=accounts | where balance > 2';
    const tree = buildTree(query);
    const original = explainDiag('sort', query);
    const [resolved] = resolveExplainRanges([original], tree, ruleNameToIndex);
    expect(resolved.range).toEqual(original.range);
  });

  it('attaches a Tier-1 additive quick-fix over the comparison span (integer field)', () => {
    const query = 'source=accounts | where age - 2 > 30';
    const tree = buildTree(query);
    const [resolved] = resolveExplainRanges(
      [explainDiag('filter', query)],
      tree,
      ruleNameToIndex,
      new Map([['age', 'integer']])
    );

    expect(resolved.fix?.text).toBe('age > 32');
    // The fix range covers the comparison, not the whole query.
    expect(
      slice(query, resolved.fix ? { ...resolved, range: resolved.fix.range! } : resolved)
    ).toBe('age - 2 > 30');
    // Hover facts get the recovered field + literal.
    expect(resolved.hoverFacts?.field).toBe('age');
    expect(resolved.hoverFacts?.literal).toBe('30');
    expect(resolved.hoverFacts?.operation).toBeUndefined();
  });

  it('offers the additive fix only for an integer field, never float or unknown', () => {
    const query = 'source=accounts | where price - 2 > 30';
    const tree = buildTree(query);

    // Float field: the exact rewrite diverges from IEEE-754 at boundary values.
    const withFloat = resolveExplainRanges(
      [explainDiag('filter', query)],
      tree,
      ruleNameToIndex,
      new Map([['price', 'double']])
    );
    expect(withFloat[0].fix).toBeUndefined();
    // Still narrows the range even when no fix is offered.
    expect(withFloat[0].range.startColumn).toBeGreaterThan(0);

    // Unknown type (no map): no fix.
    const noTypeMap = resolveExplainRanges([explainDiag('filter', query)], tree, ruleNameToIndex);
    expect(noTypeMap[0].fix).toBeUndefined();

    // Integer type: fix offered.
    const withInt = resolveExplainRanges(
      [explainDiag('filter', query)],
      tree,
      ruleNameToIndex,
      new Map([['price', 'long']])
    );
    expect(withInt[0].fix?.text).toBe('price > 32');
  });

  it('does NOT corrupt a NOT-prefixed predicate (drops no negation, invents no field)', () => {
    // Regression: getText() on the whole where-clause would fuse `NOT`+`age` into
    // `NOTage`. Deriving the fix from the comparisonExpression node avoids that —
    // the fix, if any, is a clean comparison rewrite and never rewrites `NOTage`.
    const query = 'source=accounts | where NOT age - 2 > 30';
    const tree = buildTree(query);
    const [resolved] = resolveExplainRanges(
      [explainDiag('filter', query)],
      tree,
      ruleNameToIndex,
      new Map([['age', 'integer']])
    );
    if (resolved.fix) {
      expect(resolved.fix.text).not.toContain('NOTage');
      expect(resolved.fix.text).toBe('age > 32');
      // The fix replaces only the comparison, leaving the NOT intact.
      expect(slice(query, { ...resolved, range: resolved.fix.range! })).toBe('age - 2 > 30');
    }
  });

  it('does not attach a fix to a compound predicate (several comparisons)', () => {
    const query = 'source=accounts | where age - 2 > 30 and age + 1 < 90';
    const tree = buildTree(query);
    const [resolved] = resolveExplainRanges(
      [explainDiag('filter', query)],
      tree,
      ruleNameToIndex,
      new Map([['age', 'integer']])
    );
    expect(resolved.fix).toBeUndefined();
  });

  it('does not attach a fix to a sort or aggregation finding', () => {
    const sortQuery = 'source=accounts | sort balance';
    const sortTree = buildTree(sortQuery);
    expect(
      resolveExplainRanges([explainDiag('sort', sortQuery)], sortTree, ruleNameToIndex)[0].fix
    ).toBeUndefined();
  });

  it('prefers an outer-pipeline command over one inside a subsearch', () => {
    // The outer where is the real target; a where inside a scalar subsearch must
    // not steal the range.
    const query =
      'source=accounts | where balance > [ source=other | where age > 1 | stats max(age) ]';
    const tree = buildTree(query);
    const [resolved] = resolveExplainRanges([explainDiag('filter', query)], tree, ruleNameToIndex);
    // Exactly one outer-pipeline where exists, so it resolves to that one.
    expect(slice(query, resolved)).toContain('balance');
  });
});
