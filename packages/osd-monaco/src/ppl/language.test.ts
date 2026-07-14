/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LintResult } from './lint/diagnostic';

// Control the lint result per call so we can force out-of-order responses.
// `mock`-prefixed so babel-plugin-jest-hoist permits referencing them inside the
// hoisted jest.mock factories below.
const mockLintFallback = jest.fn();
const mockValidateFallback = jest.fn();
const mockAnalyzeFallback = jest.fn();
const mockValidateQueriesFallback = jest.fn();
const defaultResolvePPLLintResult = (
  _model: unknown,
  content: string,
  fallback: (q: string) => Promise<LintResult>,
  _validateFallback?: (q: string) => Promise<unknown>,
  _publishResult?: (result: LintResult) => void,
  _analyzeFallback?: (q: string) => Promise<unknown>,
  _validateQueriesFallback?: (queries: string[]) => Promise<boolean[]>
) => fallback(content);
const mockResolvePPLLintResult = jest.fn(defaultResolvePPLLintResult);
const mockSetModelMarkers = jest.fn();
let mockLintContext: any;
let mockValidationResult: any;

// monaco surface used by language.ts at import time (registerPPLLanguage runs)
// and inside processLintHighlighting. Only the members touched here are mocked.
jest.mock('../monaco', () => ({
  monaco: {
    editor: {
      setModelMarkers: (...args: unknown[]) => mockSetModelMarkers(...args),
      onDidCreateModel: jest.fn(),
      onWillDisposeModel: jest.fn(),
      getModels: () => [],
      defineTheme: jest.fn(),
      // registerPPLLanguage now also registers the AI quick-fix command.
      registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
    },
    languages: {
      register: jest.fn(),
      onLanguage: jest.fn(),
      setLanguageConfiguration: jest.fn(),
      setMonarchTokensProvider: jest.fn(),
      setTokensProvider: jest.fn(),
      registerCompletionItemProvider: jest.fn(),
      registerCodeActionProvider: jest.fn(),
      registerHoverProvider: jest.fn(),
      registerDocumentRangeFormattingEditProvider: jest.fn(),
    },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Uri: { parse: (s: string) => s },
  },
}));

// The lint enable flag is on; getPPLLintContext returns no overrides (irrelevant
// to ordering). resolvePPLLintResult just delegates to the provided fallback so
// the test's queued promises drive response timing.
jest.mock('./lint_bridge', () => ({
  isPPLLintEnabled: () => true,
  getPPLLintContext: () => mockLintContext,
  resolvePPLLintResult: (
    model: unknown,
    content: string,
    fallback: (q: string) => Promise<LintResult>,
    validateFallback?: (q: string) => Promise<unknown>,
    publishResult?: (result: LintResult) => void,
    analyzeFallback?: (q: string) => Promise<unknown>,
    validateQueriesFallback?: (queries: string[]) => Promise<boolean[]>
  ) =>
    mockResolvePPLLintResult(
      model,
      content,
      fallback,
      validateFallback,
      publishResult,
      analyzeFallback,
      validateQueriesFallback
    ),
}));

// The worker proxy is set up and its lint/validate methods are exposed through
// the fallbacks that resolvePPLLintResult receives.
jest.mock('./worker_proxy_service', () => ({
  PPLWorkerProxyService: class {
    setup = jest.fn();
    lint = (...args: unknown[]) => mockLintFallback(...args);
    validate = (...args: unknown[]) => mockValidateFallback(...args);
    analyzeLint = (...args: unknown[]) => mockAnalyzeFallback(...args);
    validateLintQueries = (...args: unknown[]) => mockValidateQueriesFallback(...args);
    stop = jest.fn();
  },
}));

// revalidatePPLModel awaits processSyntaxHighlighting (the validation pass)
// before the lint pass; stub it to resolve clean so it never blocks the lint we
// are exercising. Lint and validation are independent (separate marker owners).
jest.mock('./validation_provider', () => ({
  resolvePPLValidationResult: jest.fn(() => Promise.resolve(mockValidationResult)),
}));

// Marker mapping is identity-ish: carry the rule id through so assertions can
// tell which lint pass produced the markers that were applied.
jest.mock('./lint/diagnostic_to_marker', () => ({
  diagnosticToMarker: (d: { ruleId: string }) => ({ message: d.ruleId, code: d.ruleId }),
}));
jest.mock('./lint/fix_registry', () => ({
  markerFixKey: (m: { code: string }) => m.code,
  setModelFixes: jest.fn(),
  clearModelFixes: jest.fn(),
  setModelSyntaxFixes: jest.fn(),
  clearModelSyntaxFixes: jest.fn(),
}));
jest.mock('./lint/hover/hover_registry', () => ({
  setModelHoverFacts: jest.fn(),
  clearModelHoverFacts: jest.fn(),
}));

// language.ts runs registerPPLLanguage() at import; the mocks above absorb it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { revalidatePPLModel } = require('./language');

const PPL_LANGUAGE_ID = 'PPL';

function makeModel(id: string, value = 'source=logs | head 5') {
  return {
    id,
    isDisposed: () => false,
    getValue: () => value,
    getLanguageId: () => PPL_LANGUAGE_ID,
  } as any;
}

// A LintResult carrying a single diagnostic tagged with `ruleId`.
const result = (ruleId: string): LintResult => ({
  diagnostics: [
    {
      ruleId,
      severity: 'warning',
      message: ruleId,
      range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
    },
  ],
});

// The LINT marker owner language.ts writes under (mirrors hover_provider.ts).
const LINT_OWNER = 'PPL_LINT';

function lintMarkerCalls() {
  return mockSetModelMarkers.mock.calls.filter((c) => c[1] === LINT_OWNER);
}

// revalidatePPLModel awaits processSyntaxHighlighting (which awaits the mocked
// validation result) before it kicks off the lint pass, so the lint fallback is
// invoked several microtasks deep. Flush generously so each pass has reached its
// fallback call before we drive response timing.
const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
};

describe('processLintHighlighting — generation guard (stale-response drop)', () => {
  beforeEach(() => {
    mockSetModelMarkers.mockClear();
    mockLintFallback.mockReset();
    mockValidateFallback.mockReset();
    mockAnalyzeFallback.mockReset();
    mockValidateQueriesFallback.mockReset();
    mockResolvePPLLintResult.mockReset();
    mockResolvePPLLintResult.mockImplementation(defaultResolvePPLLintResult);
    mockLintContext = undefined;
    mockValidationResult = { isValid: true, errors: [] };
  });

  it('drops an earlier pass whose response resolves AFTER a later pass', async () => {
    const model = makeModel('m1');

    // Two deferred lint responses. The FIRST pass ("stale") resolves LAST.
    let resolveStale!: (r: LintResult) => void;
    let resolveFresh!: (r: LintResult) => void;
    const stalePromise = new Promise<LintResult>((r) => (resolveStale = r));
    const freshPromise = new Promise<LintResult>((r) => (resolveFresh = r));
    mockLintFallback
      .mockReturnValueOnce(stalePromise) // pass #1
      .mockReturnValueOnce(freshPromise); // pass #2

    // Pass #1 (e.g. the context-less lint fired on model creation) and pass #2
    // (the editorDidMount revalidate, now with full context). Flush so both have
    // reached their (still-pending) fallback call and claimed their generations.
    void revalidatePPLModel(model);
    void revalidatePPLModel(model);
    await flush();
    expect(mockLintFallback).toHaveBeenCalledTimes(2);

    // Fresh (later) response arrives first and is applied.
    resolveFresh(result('fresh'));
    await flush();

    // Stale (earlier) response arrives second — must be DROPPED.
    resolveStale(result('stale'));
    await flush();

    const calls = lintMarkerCalls();
    // Exactly one set of lint markers was applied, and it is the fresh pass's.
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual([expect.objectContaining({ code: 'fresh' })]);
  });

  it('applies the response when no newer pass has superseded it', async () => {
    const model = makeModel('m2');
    mockLintFallback.mockResolvedValueOnce(result('only'));

    await revalidatePPLModel(model);
    await flush();

    const calls = lintMarkerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual([expect.objectContaining({ code: 'only' })]);
  });

  it('passes compiled lint and validate fallbacks to the bridge resolver', async () => {
    const model = makeModel('m-validate');
    mockLintFallback.mockResolvedValueOnce(result('only'));
    mockValidateFallback.mockResolvedValueOnce({ isValid: true, errors: [] });

    await revalidatePPLModel(model);
    await flush();

    expect(mockResolvePPLLintResult).toHaveBeenCalledWith(
      model,
      'source=logs | head 5',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    );

    const validateFallback = mockResolvePPLLintResult.mock.calls[0][3] as (
      query: string
    ) => Promise<unknown>;
    await expect(validateFallback('source=logs')).resolves.toEqual({
      isValid: true,
      errors: [],
    });
    expect(mockValidateFallback).toHaveBeenCalledWith('source=logs');

    mockAnalyzeFallback.mockResolvedValueOnce({ result: { diagnostics: [] } });
    const analyzeFallback = mockResolvePPLLintResult.mock.calls[0][5] as (
      query: string
    ) => Promise<unknown>;
    await expect(analyzeFallback('source=logs')).resolves.toEqual({
      result: { diagnostics: [] },
    });

    mockValidateQueriesFallback.mockResolvedValueOnce([true, false]);
    const validateQueriesFallback = mockResolvePPLLintResult.mock.calls[0][6] as (
      queries: string[]
    ) => Promise<boolean[]>;
    await expect(validateQueriesFallback(['source=logs', '| where'])).resolves.toEqual([
      true,
      false,
    ]);
  });

  it('applies guarded phased results before the bridge promise completes', async () => {
    const model = makeModel('m-phased');
    mockResolvePPLLintResult.mockImplementationOnce(
      async (
        _model,
        _content,
        _fallback,
        _validate,
        publishResult?: (value: LintResult) => void
      ) => {
        publishResult?.(result('static'));
        await Promise.resolve();
        return result('isolated');
      }
    );

    await revalidatePPLModel(model);
    await flush();

    expect(lintMarkerCalls().map((call) => call[2][0].code)).toEqual(['static', 'isolated']);
  });

  it('keeps generations independent per model', async () => {
    const a = makeModel('a');
    const b = makeModel('b');
    mockLintFallback
      .mockResolvedValueOnce(result('a-only'))
      .mockResolvedValueOnce(result('b-only'));

    await revalidatePPLModel(a);
    await revalidatePPLModel(b);
    await flush();

    // Both models' single passes apply — one model's lint does not invalidate
    // another's (the counter is keyed by model id).
    const owners = lintMarkerCalls().map((c) => c[0].id);
    expect(owners).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('forwards a worker-safe lint context payload to the compiled fallback', async () => {
    const model = makeModel('m3');
    const overrides = { 'head-without-sort': { enabled: false } };
    mockLintContext = {
      useRuntimeGrammar: true,
      dataSourceId: 'ds-1',
      dataSourceVersion: '3.5.0',
      isCalcite: true,
      fields: new Set(['body']),
      typeMap: new Map([['body', 'text']]),
      disabledObjectFields: new Set(['raw']),
      visibleIndices: ['logs-2026'],
      settings: { allJoinTypesAllowed: true },
      overrides,
      http: { post: jest.fn() },
    };
    mockLintFallback.mockResolvedValueOnce({ diagnostics: [] });

    await revalidatePPLModel(model);
    await flush();

    expect(mockLintFallback).toHaveBeenCalledTimes(1);
    const payload = mockLintFallback.mock.calls[0][1];
    expect(payload).toEqual({
      dataSourceId: 'ds-1',
      dataSourceVersion: '3.5.0',
      isCalcite: true,
      fields: ['body'],
      typeMap: [['body', 'text']],
      disabledObjectFields: ['raw'],
      visibleIndices: ['logs-2026'],
      settings: { allJoinTypesAllowed: true },
      overrides,
    });
    expect(payload).not.toHaveProperty('http');
    expect(payload).not.toHaveProperty('useRuntimeGrammar');
  });
});
