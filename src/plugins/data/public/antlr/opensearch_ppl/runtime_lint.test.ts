/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CharStream, CommonTokenStream } from 'antlr4ng';
import { SimplifiedOpenSearchPPLLexer, SimplifiedOpenSearchPPLParser } from '@osd/antlr-grammar';
import { CachedGrammar, pplGrammarCache } from './ppl_grammar_cache';
import { lintRuntimePPLQuery } from './runtime_lint';
import { openSearchPplAutocompleteData as simplifiedPplAutocompleteData } from './simplified_ppl_grammar/opensearch_ppl_autocomplete';

describe('lintRuntimePPLQuery', () => {
  const buildRuntimeGrammar = (overrides: Partial<CachedGrammar> = {}): CachedGrammar => {
    const lexer = new SimplifiedOpenSearchPPLLexer(CharStream.fromString(''));
    const tokenStream = new CommonTokenStream(lexer);
    const parser = new SimplifiedOpenSearchPPLParser(tokenStream);

    const runtimeSymbolicNameToTokenType = new Map<string, number>();
    for (let i = 0; i <= parser.vocabulary.maxTokenType; i++) {
      const symbolicName = parser.vocabulary.getSymbolicName(i);
      if (symbolicName) {
        runtimeSymbolicNameToTokenType.set(symbolicName, i);
      }
    }

    const runtimeRuleNameToIndex = new Map<string, number>();
    parser.ruleNames.forEach((name, idx) => runtimeRuleNameToIndex.set(name, idx));

    return {
      lexerATN: lexer.interpreter.atn,
      parserATN: parser.interpreter.atn,
      vocabulary: parser.vocabulary,
      lexerRuleNames: lexer.ruleNames,
      parserRuleNames: parser.ruleNames,
      channelNames: lexer.channelNames,
      modeNames: lexer.modeNames,
      startRuleIndex: 0,
      pipeStartRuleIndex: parser.ruleNames.indexOf('commands'),
      grammarHash: 'runtime-lint-test-grammar',
      tokenDictionary: simplifiedPplAutocompleteData.tokenDictionary,
      ignoredTokens: Array.from(simplifiedPplAutocompleteData.ignoredTokens),
      rulesToVisit: Array.from(simplifiedPplAutocompleteData.rulesToVisit),
      runtimeSymbolicNameToTokenType,
      runtimeRuleNameToIndex,
      ...overrides,
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null when runtime grammar is not enabled', () => {
    expect(
      lintRuntimePPLQuery({
        content: 'source=logs | head 10',
        context: undefined,
        model: {} as any,
      })
    ).toBeNull();
  });

  it('returns null on a cache miss (triggers compiled fallback)', () => {
    jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(null);
    expect(
      lintRuntimePPLQuery({
        content: 'source=logs | head 10',
        context: { useRuntimeGrammar: true, dataSourceId: 'ds-1' },
        model: {} as any,
      })
    ).toBeNull();
  });

  it('lints against the runtime grammar and flags head-without-sort', () => {
    jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

    const result = lintRuntimePPLQuery({
      content: 'source=logs | head 10',
      context: { useRuntimeGrammar: true },
      model: {} as any,
    });

    expect(result).not.toBeNull();
    expect(result!.diagnostics.map((d) => d.ruleId)).toContain('head-without-sort');
  });

  it('flags an unsupported window function on the runtime surface', () => {
    jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

    const result = lintRuntimePPLQuery({
      content: 'source=logs | eventstats rank() as r by status',
      context: { useRuntimeGrammar: true },
      model: {} as any,
    });

    expect(result!.diagnostics.map((d) => d.ruleId)).toContain(
      'unsupported-window-function-in-eventstats'
    );
  });
});
