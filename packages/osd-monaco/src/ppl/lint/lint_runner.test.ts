/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as antlr from 'antlr4ng';
import { SimplifiedOpenSearchPPLLexer, SimplifiedOpenSearchPPLParser } from '@osd/antlr-grammar';
import { runLint } from './lint_runner';
import { REX_NO_UNDERSCORE_METADATA } from './rules/rex_no_underscore';

// M3 — validates Property 4 (rule specificity) plus silent-failure isolation.
// Validates Requirement 9.2.

const parse = (query: string): antlr.ParserRuleContext => {
  const inputStream = antlr.CharStream.fromString(query);
  const lexer = new SimplifiedOpenSearchPPLLexer(inputStream);
  const tokenStream = new antlr.CommonTokenStream(lexer);
  const parser = new SimplifiedOpenSearchPPLParser(tokenStream);
  return parser.root();
};

describe('runLint', () => {
  it('returns an empty array for a null tree', () => {
    expect(runLint(null)).toEqual([]);
  });

  it('returns an empty array for a clean tree', () => {
    const tree = parse('source=logs | head 10');

    expect(runLint(tree)).toEqual([]);
  });

  it('returns one diagnostic carrying the rule metadata for an offending rexExpr', () => {
    const tree = parse('source=t | rex field=m "(?<user_id>\\d+)"');

    const diagnostics = runLint(tree);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: REX_NO_UNDERSCORE_METADATA.id,
      severity: REX_NO_UNDERSCORE_METADATA.severity,
      message: REX_NO_UNDERSCORE_METADATA.message,
      docUrl: REX_NO_UNDERSCORE_METADATA.docUrl,
    });
  });

  it('isolates a throwing visitor and does not break collection', () => {
    // A malformed tree object whose accept() throws should be swallowed, not
    // propagated — runLint guards each rule walk in try/catch.
    const throwingTree = ({
      accept() {
        throw new Error('boom');
      },
    } as unknown) as antlr.ParserRuleContext;

    expect(() => runLint(throwingTree)).not.toThrow();
    expect(runLint(throwingTree)).toEqual([]);
  });
});
