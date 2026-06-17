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

  describe('pipe-first column remap', () => {
    it('subtracts the synthetic prefix width from line-one columns', () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

      // `| head 10` is parsed with a synthetic `source=t ` (9-char) prefix. The
      // head-without-sort squiggle must point at `head` in the user's text
      // (0-based column 2), not 9 columns to the right.
      const pipeFirst = lintRuntimePPLQuery({
        content: '| head 10',
        context: { useRuntimeGrammar: true },
        model: {} as any,
      });
      const head = pipeFirst!.diagnostics.find((d) => d.ruleId === 'head-without-sort');
      expect(head).toBeDefined();
      expect(head!.range.startLine).toBe(1);
      expect(head!.range.startColumn).toBe(2);
      expect(head!.range.endColumn).toBe(9);
    });

    it('does not shift columns for a non-pipe-first query', () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

      const regular = lintRuntimePPLQuery({
        content: 'source=logs | head 10',
        context: { useRuntimeGrammar: true },
        model: {} as any,
      });
      const head = regular!.diagnostics.find((d) => d.ruleId === 'head-without-sort');
      expect(head).toBeDefined();
      // `head` sits at 0-based column 14 in `source=logs | head 10`; unchanged.
      expect(head!.range.startColumn).toBe(14);
    });
  });

  describe('silent-failure rules on the runtime surface', () => {
    const typeMap = new Map<string, string>([
      ['age', 'long'],
      ['balance', 'long'],
      ['firstname', 'text'],
      ['attributes', 'flat_object'],
    ]);
    const fields = new Set<string>([...typeMap.keys(), 'raw']);
    const runtimeContext = {
      useRuntimeGrammar: true,
      fields,
      typeMap,
      disabledObjectFields: new Set(['raw']),
    };

    const runtimeIds = (content: string): string[] => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const result = lintRuntimePPLQuery({ content, context: runtimeContext, model: {} as any });
      return result!.diagnostics.map((d) => d.ruleId);
    };

    it('flags division-by-zero', () => {
      expect(runtimeIds('source=accounts | eval x = balance / 0')).toContain('division-by-zero');
    });

    it('flags agg-on-text', () => {
      expect(runtimeIds('source=accounts | stats avg(firstname)')).toContain('agg-on-text');
    });

    it('flags flat-object-subfield', () => {
      expect(runtimeIds('source=otel | where attributes.http.method = "GET"')).toContain(
        'flat-object-subfield'
      );
    });

    it('flags type-mismatch-numeric', () => {
      expect(runtimeIds('source=accounts | where age = "thirty"')).toContain(
        'type-mismatch-numeric'
      );
    });

    it('does not flag a coercible quoted number for type-mismatch-numeric', () => {
      expect(runtimeIds('source=accounts | where age = "32"')).not.toContain(
        'type-mismatch-numeric'
      );
    });

    it('flags enabled-false-object', () => {
      expect(runtimeIds('source=otel | fields raw.k.deep')).toContain('enabled-false-object');
    });
  });
});
