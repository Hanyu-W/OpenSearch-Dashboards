/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as antlr from 'antlr4ng';
import { SimplifiedOpenSearchPPLLexer, SimplifiedOpenSearchPPLParser } from '@osd/antlr-grammar';
import { RexNoUnderscoreVisitor, REX_NO_UNDERSCORE_METADATA } from './rex_no_underscore';
import type { Diagnostic } from '../diagnostic';

// M2 — real-tree visitor coverage. M7 — pure regex sanity.
// Validates Property 4 (Rule specificity) and Requirements 1.1, 1.2, 1.6, 8.1, 8.2, 8.3.

const lintQuery = (query: string): Diagnostic[] => {
  const inputStream = antlr.CharStream.fromString(query);
  const lexer = new SimplifiedOpenSearchPPLLexer(inputStream);
  const tokenStream = new antlr.CommonTokenStream(lexer);
  const parser = new SimplifiedOpenSearchPPLParser(tokenStream);
  const tree = parser.root();

  const visitor = new RexNoUnderscoreVisitor(REX_NO_UNDERSCORE_METADATA);
  visitor.visit(tree);
  return visitor.diagnostics;
};

describe('RexNoUnderscoreVisitor (M2)', () => {
  it('fires for an underscore in the capture-group name', () => {
    const diagnostics = lintQuery('source=t | rex field=m "(?<user_id>\\d+)"');

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe('rex-no-underscore');
    expect(diagnostics[0].severity).toBe('warning');
  });

  it('skips a correctly-formed capture-group name with no underscore', () => {
    const diagnostics = lintQuery('source=t | rex field=m "(?<userId>\\d+)"');

    expect(diagnostics).toHaveLength(0);
  });

  it('ignores an underscore that appears only in the regex body', () => {
    const diagnostics = lintQuery('source=t | rex field=m "(?<userId>foo_bar)"');

    expect(diagnostics).toHaveLength(0);
  });

  it('also fires for the (?P< opener (opener-agnostic)', () => {
    const diagnostics = lintQuery('source=t | rex field=m "(?P<user_id>\\d+)"');

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe('rex-no-underscore');
  });

  it('fires once per offending rex stage when there are two stages', () => {
    const diagnostics = lintQuery(
      'source=t | rex field=m "(?<user_id>\\d+)" | rex field=n "(?<order_id>\\d+)"'
    );

    expect(diagnostics).toHaveLength(2);
  });

  it('emits a range that covers the literal including its surrounding quotes', () => {
    const query = 'source=t | rex field=m "(?<user_id>\\d+)"';
    const diagnostics = lintQuery(query);

    expect(diagnostics).toHaveLength(1);
    const { range } = diagnostics[0];
    // The literal starts at the opening quote and ends after the closing quote.
    const openingQuoteIndex = query.indexOf('"');
    expect(range.startLine).toBe(1);
    // ANTLR 0-based column equals the string index on line 1.
    expect(range.startColumn).toBe(openingQuoteIndex);
    // End column is exclusive and sits just past the closing quote.
    expect(range.endColumn).toBe(query.length);
  });
});

describe('NAMED_CAPTURE_WITH_UNDERSCORE regex sanity (M7)', () => {
  // Re-declare the same pattern the rule uses to validate it in isolation.
  const NAMED_CAPTURE_WITH_UNDERSCORE = /\(\?P?<[^>]*_[^>]*>/;

  it('matches (?<a_b>x)', () => {
    expect(NAMED_CAPTURE_WITH_UNDERSCORE.test('(?<a_b>x)')).toBe(true);
  });

  it('matches (?P<a_b>x) (opener-agnostic)', () => {
    expect(NAMED_CAPTURE_WITH_UNDERSCORE.test('(?P<a_b>x)')).toBe(true);
  });

  it('does not match (?<ab>x_y) (underscore in body)', () => {
    expect(NAMED_CAPTURE_WITH_UNDERSCORE.test('(?<ab>x_y)')).toBe(false);
  });

  it('does not match (?:_) (non-capturing, no name)', () => {
    expect(NAMED_CAPTURE_WITH_UNDERSCORE.test('(?:_)')).toBe(false);
  });
});
