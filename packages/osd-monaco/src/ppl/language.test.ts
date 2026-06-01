/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// M6 — editor wiring for lint highlighting.
// Validates Property 2 (marker-owner isolation), Property 5 (no-stale-marker),
// Property 6 (non-blocking) and Requirements 2.3, 4.1, 4.3, 7.3, 7.4, 7.5, 7.6,
// 9.4, 9.5.

const mockSetModelMarkers = jest.fn<void, any[]>();
const mockOnDidCreateModel = jest.fn<{ dispose: () => void }, any[]>(() => ({
  dispose: jest.fn(),
}));
const mockOnWillDisposeModel = jest.fn<{ dispose: () => void }, any[]>(() => ({
  dispose: jest.fn(),
}));
const mockLint = jest.fn();
const mockValidate = jest.fn(() => Promise.resolve({ isValid: true, errors: [] }));
const mockSetup = jest.fn();
const mockStop = jest.fn();

jest.mock('../monaco', () => ({
  monaco: {
    editor: {
      setModelMarkers: (...args: any[]) => mockSetModelMarkers(...args),
      onDidCreateModel: (...args: any[]) => mockOnDidCreateModel(...args),
      onWillDisposeModel: (...args: any[]) => mockOnWillDisposeModel(...args),
      getModels: () => [],
    },
    languages: {
      register: jest.fn(),
      setLanguageConfiguration: jest.fn(),
      setTokensProvider: jest.fn(),
      registerDocumentRangeFormattingEditProvider: jest.fn(),
    },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    Uri: { parse: (url: string) => ({ url }) },
  },
}));

jest.mock('./worker_proxy_service', () => ({
  PPLWorkerProxyService: jest.fn().mockImplementation(() => ({
    setup: mockSetup,
    lint: mockLint,
    validate: mockValidate,
    stop: mockStop,
    tokenize: jest.fn(),
  })),
}));

// Importing the module triggers registerPPLLanguage(), which registers the
// model handlers on our mocked monaco.editor. We use require (not a hoisted
// import) so the mock consts above are initialized before the module loads.

require('./language');

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

const PPL_LINT = 'PPL_LINT';
const PPL_WORKER = 'PPL_WORKER';

// Captured at module-load time (registerPPLLanguage runs on require).
const handleModel: (model: any) => void = mockOnDidCreateModel.mock.calls[0][0];
const disposeHandler: (model: any) => void = mockOnWillDisposeModel.mock.calls[0][0];

interface FakeModel {
  getLanguageId: jest.Mock;
  getValue: jest.Mock;
  isDisposed: jest.Mock;
  onDidChangeContent: jest.Mock;
  onDidChangeLanguage: jest.Mock;
  _listeners: { content?: () => Promise<void>; language?: () => Promise<void> };
}

const makeModel = (value = 'source=t | rex field=m "(?<a_b>x)"'): FakeModel => {
  const listeners: FakeModel['_listeners'] = {};
  return {
    getLanguageId: jest.fn(() => 'PPL'),
    getValue: jest.fn(() => value),
    isDisposed: jest.fn(() => false),
    onDidChangeContent: jest.fn((cb: () => Promise<void>) => {
      listeners.content = cb;
      return { dispose: jest.fn() };
    }),
    onDidChangeLanguage: jest.fn((cb: () => Promise<void>) => {
      listeners.language = cb;
      return { dispose: jest.fn() };
    }),
    _listeners: listeners,
  };
};

const offending = {
  ruleId: 'rex-no-underscore',
  severity: 'warning' as const,
  message: 'no underscores',
  docUrl: 'https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/rex/',
  range: { startLine: 1, startColumn: 23, endLine: 1, endColumn: 33 },
};

const lintMarkerCalls = () => mockSetModelMarkers.mock.calls.filter((c) => c[1] === PPL_LINT);

describe('PPL lint editor wiring (M6)', () => {
  beforeEach(() => {
    mockSetModelMarkers.mockClear();
    mockSetup.mockClear();
    mockValidate.mockClear();
    mockValidate.mockResolvedValue({ isValid: true, errors: [] });
    mockLint.mockReset();
    mockLint.mockResolvedValue({ diagnostics: [] });
  });

  it('sets PPL_LINT markers when diagnostics are returned', async () => {
    mockLint.mockResolvedValue({ diagnostics: [offending] });
    const model = makeModel();

    handleModel(model);
    await flushPromises();

    const last = lintMarkerCalls().pop();
    expect(last).toBeDefined();
    expect(last![0]).toBe(model);
    expect(last![2]).toHaveLength(1);
  });

  it('clears PPL_LINT markers to an empty set when no diagnostics are returned', async () => {
    mockLint.mockResolvedValue({ diagnostics: [] });
    const model = makeModel();

    handleModel(model);
    await flushPromises();

    const last = lintMarkerCalls().pop();
    expect(last).toBeDefined();
    expect(last![2]).toEqual([]);
  });

  it('drops the result via the staleness guard when content changed during the round-trip', async () => {
    const model = makeModel('original');
    mockLint.mockImplementation(async () => {
      // Simulate the user editing during the async worker round-trip.
      model.getValue.mockReturnValue('changed');
      return { diagnostics: [offending] };
    });

    handleModel(model);
    await flushPromises();

    // Guard returns before setting markers — no PPL_LINT marker call at all.
    expect(lintMarkerCalls()).toHaveLength(0);
  });

  it('clears PPL_LINT markers on model dispose', () => {
    const model = makeModel();

    disposeHandler(model);

    expect(mockSetModelMarkers).toHaveBeenCalledWith(model, PPL_LINT, []);
  });

  it('clears PPL_LINT markers when the language changes away from PPL', async () => {
    const model = makeModel();
    handleModel(model);
    await flushPromises();
    mockSetModelMarkers.mockClear();

    // Language switches away from PPL.
    model.getLanguageId.mockReturnValue('plaintext');
    await model._listeners.language!();

    expect(mockSetModelMarkers).toHaveBeenCalledWith(model, PPL_LINT, []);
  });

  it('does not block syntax highlighting on a slow lint pass (non-blocking)', async () => {
    // Lint never resolves; syntax highlighting must still complete.
    mockLint.mockImplementation(() => new Promise(() => undefined));
    const model = makeModel();
    handleModel(model);
    // Register the content listener, then fire it.
    await model._listeners.content!();
    await flushPromises();

    // Syntax markers (PPL_WORKER) were set even though lint is still pending.
    expect(mockSetModelMarkers.mock.calls.some((c) => c[1] === PPL_WORKER)).toBe(true);
    // Lint was kicked off (fire-and-forget).
    expect(mockLint).toHaveBeenCalled();
  });
});
