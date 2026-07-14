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
import { PPLLanguageAnalyzer } from '@osd/monaco/target/ppl/ppl_language_analyzer';

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
        logical: { rels: [{ relOp: 'LogicalFilter' }] },
        physical: {
          rels: [
            {
              relOp: 'CalciteEnumerableIndexScan',
              PushDownContext: ['PROJECT->[firstname, age]', 'SCRIPT->>(-($1, 2), 30)'],
              sourceBuilder: {
                query: { script: { script: { lang: 'opensearch_compounded_script' } } },
              },
            },
          ],
        },
      },
    };
    const legacyStringScriptPlan = {
      calcite: {
        logical: 'LogicalFilter',
        physical:
          'CalciteEnumerableIndexScan(table=[[OpenSearch, accounts]], PushDownContext=[[PROJECT->[age], SCRIPT->>(-($1, 2), 30), LIMIT->10000], OpenSearchRequestBuilder(sourceBuilder={"query":{"script":{"script":{"lang":"opensearch_compounded_script"}}}})])',
      },
    };
    const nativeFilterPlan = {
      calcite: {
        logical: { rels: [{ relOp: 'LogicalFilter' }] },
        physical: {
          rels: [
            {
              relOp: 'CalciteEnumerableIndexScan',
              PushDownContext: ['PROJECT->[age]', 'FILTER->>($0, 30)', 'LIMIT->10000'],
              sourceBuilder: { query: { range: { age: { from: 30 } } } },
            },
          ],
        },
      },
    };
    const compiledStaticResult = (ruleId = 'compiled-static') => ({
      diagnostics: [
        {
          ruleId,
          severity: 'warning',
          message: ruleId,
          range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
        },
      ],
    });

    afterEach(() => {
      explainCache.clear();
    });

    it('keeps legacy compiled callers static-only when no snapshot callback is available', async () => {
      const query = 'source=accounts | where age - 2 > 30';
      const http = { post: jest.fn().mockResolvedValue(legacyStringScriptPlan) } as any;
      const compiledFallbackLint = jest.fn().mockResolvedValue(compiledStaticResult());
      const compiledFallbackValidate = jest.fn().mockResolvedValue({ isValid: true, errors: [] });

      const result = await lintRuntimePPLQuery({
        content: query,
        context: {
          ...baseContext,
          useRuntimeGrammar: false,
          dataSourceVersion: '3.5.0',
          http,
          dataSourceId: 'ds-compiled-35',
        },
        compiledFallbackLint,
        compiledFallbackValidate,
        model: {} as any,
      });

      expect(compiledFallbackLint).toHaveBeenCalledWith(query);
      expect(compiledFallbackValidate).not.toHaveBeenCalled();
      expect(http.post).not.toHaveBeenCalled();
      expect(result!.diagnostics.map((d) => d.ruleId)).toEqual(['compiled-static']);
    });

    it.each(['3.3.0', '3.4.0', '3.5.0'])(
      'uses a compiled-worker snapshot for exact attribution on %s',
      async (dataSourceVersion) => {
        const query = 'source=accounts | where age - 2 > 30';
        const events: string[] = [];
        const http = {
          post: jest.fn(async () => {
            events.push('explain');
            return legacyStringScriptPlan;
          }),
        } as any;
        const analyzer = new PPLLanguageAnalyzer();
        const analysis = analyzer.analyzeLint(query, {
          dataSourceVersion,
          isCalcite: true,
          overrides: baseContext.overrides,
        });
        const compiledFallbackAnalyze = jest.fn().mockResolvedValue({
          ...analysis,
          result: compiledStaticResult(),
        });
        const compiledFallbackLint = jest.fn().mockResolvedValue(compiledStaticResult());
        const publishResult = jest.fn(() => events.push('publish'));

        const result = await lintRuntimePPLQuery({
          content: query,
          context: {
            ...baseContext,
            useRuntimeGrammar: false,
            dataSourceVersion,
            http,
            dataSourceId: `ds-compiled-${dataSourceVersion}`,
          },
          compiledFallbackLint,
          compiledFallbackAnalyze,
          compiledFallbackValidateProbes: jest.fn().mockResolvedValue([true]),
          publishResult,
          model: {
            getValue: () => query,
            getVersionId: () => 1,
            isDisposed: () => false,
          } as any,
        });

        expect(compiledFallbackAnalyze).toHaveBeenCalledWith(query);
        expect(compiledFallbackLint).not.toHaveBeenCalled();
        expect(events[0]).toBe('publish');
        expect(http.post).toHaveBeenCalledTimes(1);
        const performance = result!.diagnostics.find(
          ({ ruleId }) => ruleId === 'operation-pushed-as-script'
        );
        expect(performance).toBeDefined();
        expect(query.slice(performance!.range.startColumn, performance!.range.endColumn)).toBe(
          'age - 2 > 30'
        );
      }
    );

    it('batch-validates compiled probes and isolates the scripted 3.5 filter', async () => {
      const query = 'source=accounts | where age > 1 | where age - 2 > 30';
      const http = {
        post: jest.fn(async (_path: string, options: { body?: BodyInit | null }) => {
          const generated = JSON.parse(String(options.body)).query as string;
          return generated.includes('age - 2 > 30') ? legacyStringScriptPlan : nativeFilterPlan;
        }),
      } as any;
      const analyzer = new PPLLanguageAnalyzer();
      const analysis = analyzer.analyzeLint(query, {
        dataSourceVersion: '3.5.0',
        isCalcite: true,
        overrides: baseContext.overrides,
      });
      const compiledFallbackValidateProbes = jest.fn(async (queries: string[]) =>
        queries.map(() => true)
      );

      const result = await lintRuntimePPLQuery({
        content: query,
        context: {
          ...baseContext,
          useRuntimeGrammar: false,
          dataSourceVersion: '3.5.0',
          http,
          dataSourceId: 'ds-compiled-35-isolation',
        },
        compiledFallbackLint: jest.fn().mockResolvedValue(compiledStaticResult()),
        compiledFallbackAnalyze: jest.fn().mockResolvedValue(analysis),
        compiledFallbackValidateProbes,
        model: {
          getValue: () => query,
          getVersionId: () => 1,
          isDisposed: () => false,
        } as any,
      });

      expect(compiledFallbackValidateProbes).toHaveBeenCalledTimes(1);
      expect(compiledFallbackValidateProbes.mock.calls[0][0]).toHaveLength(3);
      expect(http.post).toHaveBeenCalledTimes(4);
      const performance = result!.diagnostics.filter(
        ({ ruleId }) => ruleId === 'operation-pushed-as-script'
      );
      expect(performance).toHaveLength(1);
      expect(query.slice(performance[0].range.startColumn, performance[0].range.endColumn)).toBe(
        'age - 2 > 30'
      );
    });

    it('keeps compiled static markers and skips explain when worker analysis has no snapshot', async () => {
      const query = 'source=accounts | ';
      const http = { post: jest.fn().mockResolvedValue(legacyStringScriptPlan) } as any;
      const staticResult = compiledStaticResult('compiled-invalid-static');
      const compiledFallbackLint = jest.fn().mockResolvedValue(staticResult);
      const compiledFallbackAnalyze = jest.fn().mockResolvedValue({
        result: staticResult,
      });

      const result = await lintRuntimePPLQuery({
        content: query,
        context: {
          ...baseContext,
          useRuntimeGrammar: false,
          dataSourceVersion: '3.5.0',
          http,
          dataSourceId: 'ds-compiled-invalid',
        },
        compiledFallbackLint,
        compiledFallbackAnalyze,
        model: {} as any,
      });

      expect(result).toBe(staticResult);
      expect(compiledFallbackAnalyze).toHaveBeenCalledWith(query);
      expect(compiledFallbackLint).not.toHaveBeenCalled();
      expect(http.post).not.toHaveBeenCalled();
    });

    it('does not validate or explain the compiled fallback when explain rules are disabled by default', async () => {
      const query = 'source=accounts | where age - 2 > 30';
      const http = { post: jest.fn().mockResolvedValue(legacyStringScriptPlan) } as any;
      const staticResult = compiledStaticResult('compiled-default-static');
      const compiledFallbackLint = jest.fn().mockResolvedValue(staticResult);
      const compiledFallbackValidate = jest.fn().mockResolvedValue({ isValid: true, errors: [] });
      const compiledFallbackAnalyze = jest.fn();

      const result = await lintRuntimePPLQuery({
        content: query,
        context: {
          useRuntimeGrammar: false,
          isCalcite: true,
          dataSourceVersion: '3.5.0',
          http,
          dataSourceId: 'ds-compiled-defaults',
        },
        compiledFallbackLint,
        compiledFallbackValidate,
        compiledFallbackAnalyze,
        model: {} as any,
      });

      expect(result).toBe(staticResult);
      expect(compiledFallbackLint).toHaveBeenCalledWith(query);
      expect(compiledFallbackValidate).not.toHaveBeenCalled();
      expect(compiledFallbackAnalyze).not.toHaveBeenCalled();
      expect(http.post).not.toHaveBeenCalled();
    });

    it('does not lint, validate, or explain empty compiled-fallback queries', async () => {
      const http = { post: jest.fn().mockResolvedValue(legacyStringScriptPlan) } as any;
      const compiledFallbackLint = jest.fn().mockResolvedValue(compiledStaticResult());
      const compiledFallbackValidate = jest.fn().mockResolvedValue({ isValid: true, errors: [] });
      const compiledFallbackAnalyze = jest.fn();

      const result = await lintRuntimePPLQuery({
        content: '   ',
        context: {
          ...baseContext,
          useRuntimeGrammar: true,
          dataSourceVersion: '3.5.0',
          http,
          dataSourceId: 'ds-runtime-empty',
        },
        compiledFallbackLint,
        compiledFallbackValidate,
        compiledFallbackAnalyze,
        model: {} as any,
      });

      expect(result).toEqual({ diagnostics: [] });
      expect(compiledFallbackLint).not.toHaveBeenCalled();
      expect(compiledFallbackValidate).not.toHaveBeenCalled();
      expect(compiledFallbackAnalyze).not.toHaveBeenCalled();
      expect(http.post).not.toHaveBeenCalled();
    });

    it('uses only compiled static lint when the runtime grammar cache misses', async () => {
      const query = 'source=accounts | where age - 2 > 30';
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(null);
      const http = { post: jest.fn().mockResolvedValue(legacyStringScriptPlan) } as any;
      const compiledFallbackLint = jest.fn().mockResolvedValue(compiledStaticResult());
      const compiledFallbackValidate = jest.fn().mockResolvedValue({ isValid: true, errors: [] });
      const compiledFallbackAnalyze = jest.fn();

      const result = await lintRuntimePPLQuery({
        content: query,
        context: {
          ...baseContext,
          useRuntimeGrammar: true,
          dataSourceVersion: '3.5.0',
          http,
          dataSourceId: 'ds-runtime-cache-miss',
        },
        compiledFallbackLint,
        compiledFallbackValidate,
        compiledFallbackAnalyze,
        model: {} as any,
      });

      expect(compiledFallbackLint).toHaveBeenCalledWith(query);
      expect(compiledFallbackValidate).not.toHaveBeenCalled();
      expect(compiledFallbackAnalyze).not.toHaveBeenCalled();
      expect(http.post).not.toHaveBeenCalled();
      expect(result!.diagnostics.map((d) => d.ruleId)).toEqual(['compiled-static']);
    });

    it('version-gates compiled Explain attribution below 3.3', async () => {
      const query = 'source=accounts | where age - 2 > 30';
      const http = { post: jest.fn() } as any;
      const staticResult = compiledStaticResult('compiled-219-static');
      const compiledFallbackLint = jest.fn().mockResolvedValue(staticResult);
      const compiledFallbackAnalyze = jest.fn();

      const result = await lintRuntimePPLQuery({
        content: query,
        context: {
          ...baseContext,
          useRuntimeGrammar: false,
          dataSourceVersion: '2.19.0',
          http,
          dataSourceId: 'ds-compiled-219',
        },
        compiledFallbackLint,
        compiledFallbackAnalyze,
        model: {} as any,
      });

      expect(result).toBe(staticResult);
      expect(compiledFallbackLint).toHaveBeenCalledWith(query);
      expect(compiledFallbackAnalyze).not.toHaveBeenCalled();
      expect(http.post).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', undefined],
      ['malformed', 'not-a-version'],
    ])(
      'keeps compiled lint static-only when the cluster version is %s',
      async (_label, dataSourceVersion) => {
        const query = 'source=accounts | where age - 2 > 30';
        const http = { post: jest.fn() } as any;
        const staticResult = compiledStaticResult('compiled-unknown-version-static');
        const compiledFallbackLint = jest.fn().mockResolvedValue(staticResult);
        const compiledFallbackAnalyze = jest.fn();

        const result = await lintRuntimePPLQuery({
          content: query,
          context: {
            ...baseContext,
            useRuntimeGrammar: false,
            dataSourceVersion,
            http,
            dataSourceId: `ds-compiled-${_label}-version`,
          },
          compiledFallbackLint,
          compiledFallbackAnalyze,
          model: {} as any,
        });

        expect(result).toBe(staticResult);
        expect(compiledFallbackLint).toHaveBeenCalledWith(query);
        expect(compiledFallbackAnalyze).not.toHaveBeenCalled();
        expect(http.post).not.toHaveBeenCalled();
      }
    );

    it('does not explain a compiled snapshot that became stale while the worker ran', async () => {
      const query = 'source=accounts | where age - 2 > 30';
      let modelValue = query;
      const http = { post: jest.fn() } as any;
      const analyzer = new PPLLanguageAnalyzer();
      const analysis = analyzer.analyzeLint(query, {
        dataSourceVersion: '3.5.0',
        isCalcite: true,
        overrides: baseContext.overrides,
      });
      const compiledFallbackAnalyze = jest.fn(async () => {
        modelValue = `${query} `;
        return analysis;
      });

      await lintRuntimePPLQuery({
        content: query,
        context: {
          ...baseContext,
          useRuntimeGrammar: false,
          dataSourceVersion: '3.5.0',
          http,
        },
        compiledFallbackLint: jest.fn().mockResolvedValue(compiledStaticResult()),
        compiledFallbackAnalyze,
        model: {
          getValue: () => modelValue,
          getVersionId: () => 1,
          isDisposed: () => false,
        } as any,
      });

      expect(http.post).not.toHaveBeenCalled();
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

    it('keeps legacy string explain fallback markers working', async () => {
      jest.spyOn(pplGrammarCache, 'getCachedGrammar').mockReturnValue(buildRuntimeGrammar());
      const http = { post: jest.fn().mockResolvedValue(legacyStringScriptPlan) } as any;

      const result = await lintRuntimePPLQuery({
        content: 'source=accounts | where age - 2 > 30',
        context: { ...baseContext, http, dataSourceId: 'ds-explain-legacy' },
        model: {} as any,
      });

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
