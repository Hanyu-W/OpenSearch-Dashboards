/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CharStream, CommonTokenStream } from 'antlr4ng';
import { SimplifiedOpenSearchPPLLexer, SimplifiedOpenSearchPPLParser } from '@osd/antlr-grammar';
import { CachedGrammar, pplGrammarCache } from './ppl_grammar_cache';
import { lintRuntimePPLQuery } from './runtime_lint';
import { explainCache } from '../../ppl_lint/explain_cache';
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

  it('returns null when runtime grammar is not enabled', async () => {
    expect(
      await lintRuntimePPLQuery({
        content: 'source=logs | head 10',
        context: undefined,
        model: {} as any,
      })
    ).toBeNull();
  });

  it('returns null on a cache miss (triggers compiled fallback)', async () => {
    jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(null);
    expect(
      await lintRuntimePPLQuery({
        content: 'source=logs | head 10',
        context: { useRuntimeGrammar: true, dataSourceId: 'ds-1' },
        model: {} as any,
      })
    ).toBeNull();
  });

  it('lints against the runtime grammar and flags head-without-sort', async () => {
    jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

    const result = await lintRuntimePPLQuery({
      content: 'source=logs | head 10',
      context: { useRuntimeGrammar: true },
      model: {} as any,
    });

    expect(result).not.toBeNull();
    expect(result!.diagnostics.map((d) => d.ruleId)).toContain('head-without-sort');
  });

  it('flags an unsupported window function on the runtime surface', async () => {
    jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

    const result = await lintRuntimePPLQuery({
      content: 'source=logs | eventstats rank() as r by status',
      context: { useRuntimeGrammar: true },
      model: {} as any,
    });

    expect(result!.diagnostics.map((d) => d.ruleId)).toContain(
      'unsupported-window-function-in-eventstats'
    );
  });

  describe('pipe-first column remap', () => {
    it('subtracts the synthetic prefix width from line-one columns', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

      // `| head 10` is parsed with a synthetic `source=t ` (9-char) prefix. The
      // head-without-sort squiggle must point at `head` in the user's text
      // (0-based column 2), not 9 columns to the right.
      const pipeFirst = await lintRuntimePPLQuery({
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

    it('does not shift columns for a non-pipe-first query', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

      const regular = await lintRuntimePPLQuery({
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

    const runtimeIds = async (content: string): Promise<string[]> => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const result = await lintRuntimePPLQuery({
        content,
        context: runtimeContext,
        model: {} as any,
      });
      return result!.diagnostics.map((d) => d.ruleId);
    };

    it('flags division-by-zero', async () => {
      expect(await runtimeIds('source=accounts | eval x = balance / 0')).toContain(
        'division-by-zero'
      );
    });

    it('flags agg-on-text', async () => {
      expect(await runtimeIds('source=accounts | stats avg(firstname)')).toContain('agg-on-text');
    });

    it('flags flat-object-subfield', async () => {
      expect(await runtimeIds('source=otel | where attributes.http.method = "GET"')).toContain(
        'flat-object-subfield'
      );
    });

    it('flags type-mismatch-numeric', async () => {
      expect(await runtimeIds('source=accounts | where age = "thirty"')).toContain(
        'type-mismatch-numeric'
      );
    });

    it('does not flag a coercible quoted number for type-mismatch-numeric', async () => {
      expect(await runtimeIds('source=accounts | where age = "32"')).not.toContain(
        'type-mismatch-numeric'
      );
    });

    it('flags enabled-false-object', async () => {
      expect(await runtimeIds('source=otel | fields raw.k.deep')).toContain('enabled-false-object');
    });
  });

  describe('explain-backed lint layering', () => {
    const baseContext: any = {
      useRuntimeGrammar: true,
      isCalcite: true,
      dataSourceVersion: '3.7.0',
      // Enable the explain rules (shipped disabled by default) via overrides so
      // the layering path actually runs in these tests.
      overrides: {
        'operation-not-pushed': { enabled: true },
        'operation-pushed-as-script': { enabled: true },
      },
    };

    const scriptFilterPlan = {
      calcite: {
        logical: 'LogicalFilter',
        physical:
          'CalciteEnumerableIndexScan(table=[[OpenSearch, accounts]], PushDownContext=[[PROJECT->[age], SCRIPT->>(-($1, 2), 30), LIMIT->10000], OpenSearchRequestBuilder(sourceBuilder={"query":{"script":{"script":{"lang":"opensearch_compounded_script"}}}})])',
      },
    };
    const nativeFilterPlan = {
      calcite: {
        logical: 'LogicalFilter',
        physical:
          'CalciteEnumerableIndexScan(table=[[OpenSearch, accounts]], PushDownContext=[[PROJECT->[age], FILTER->>($0, 30), LIMIT->10000]])',
      },
    };

    afterEach(() => {
      explainCache.clear();
    });

    it('merges explain markers after static markers when the plan flags an anti-pattern', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const http = { post: jest.fn().mockResolvedValue(scriptFilterPlan) } as any;

      const result = await lintRuntimePPLQuery({
        content: 'source=accounts | where age - 2 > 30',
        context: { ...baseContext, http, dataSourceId: 'ds-explain-1' },
        model: {} as any,
      });

      expect(http.post).toHaveBeenCalledTimes(1);
      expect(result!.diagnostics.map((d) => d.ruleId)).toContain('operation-pushed-as-script');
    });

    it('emits no explain markers when the plan is fully pushed', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const http = { post: jest.fn().mockResolvedValue(nativeFilterPlan) } as any;

      const result = await lintRuntimePPLQuery({
        content: 'source=accounts | where age > 30',
        context: { ...baseContext, http, dataSourceId: 'ds-explain-2' },
        model: {} as any,
      });

      const ids = result!.diagnostics.map((d) => d.ruleId);
      expect(ids).not.toContain('operation-not-pushed');
      expect(ids).not.toContain('operation-pushed-as-script');
    });

    it('does not call explain when the source is not Calcite', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const http = { post: jest.fn() } as any;

      await lintRuntimePPLQuery({
        content: 'source=accounts | where age - 2 > 30',
        context: { ...baseContext, isCalcite: false, http, dataSourceId: 'ds-explain-3' },
        model: {} as any,
      });

      expect(http.post).not.toHaveBeenCalled();
    });

    it('does not call explain when no http client is present', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());

      const result = await lintRuntimePPLQuery({
        content: 'source=accounts | where age - 2 > 30',
        context: { ...baseContext, http: undefined, dataSourceId: 'ds-explain-4' },
        model: {} as any,
      });

      // Static markers still come back; no throw.
      expect(result).not.toBeNull();
    });

    it('does not call explain when every explain rule is disabled', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const http = { post: jest.fn() } as any;

      await lintRuntimePPLQuery({
        content: 'source=accounts | where age - 2 > 30',
        context: {
          useRuntimeGrammar: true,
          isCalcite: true,
          dataSourceVersion: '3.7.0',
          http,
          dataSourceId: 'ds-explain-5',
          // overrides omitted → rules stay disabled (catalog default).
        },
        model: {} as any,
      });

      expect(http.post).not.toHaveBeenCalled();
    });

    it('preserves static markers when the explain call rejects', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const http = { post: jest.fn().mockRejectedValue(new Error('network')) } as any;

      const result = await lintRuntimePPLQuery({
        content: 'source=accounts | head 10',
        context: { ...baseContext, http, dataSourceId: 'ds-explain-6' },
        model: {} as any,
      });

      // head-without-sort still fires; the explain failure is swallowed.
      expect(result!.diagnostics.map((d) => d.ruleId)).toContain('head-without-sort');
    });

    // B5: ANTLR recovers from a syntax error and still returns a (partial) tree,
    // so without honoring the error listener the explain layer would POST on a
    // half-typed query. A query with a trailing pipe is a syntax error; the
    // clean-parse precondition must keep _explain off the network.
    it('does not call explain on a syntactically-invalid (half-typed) query', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const http = { post: jest.fn().mockResolvedValue(scriptFilterPlan) } as any;

      await lintRuntimePPLQuery({
        content: 'source=accounts | ',
        context: { ...baseContext, http, dataSourceId: 'ds-explain-7' },
        model: {} as any,
      });

      expect(http.post).not.toHaveBeenCalled();
    });
  });
});
