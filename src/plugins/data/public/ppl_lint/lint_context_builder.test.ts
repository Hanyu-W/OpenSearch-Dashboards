/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { IUiSettingsClient } from 'opensearch-dashboards/public';
import { HttpSetup, NotificationsStart } from '../../../../core/public';
import { buildPPLLintContext, LintFieldsCache } from './lint_context_builder';
import { calciteSettingsCache } from './calcite_settings';
import { buildOverridesFromSettings } from './lint_overrides';
import {
  deriveIsCalcite,
  shouldUseRuntimeGrammar,
} from '../antlr/opensearch_ppl/ppl_grammar_cache';

jest.mock('./calcite_settings', () => ({
  calciteSettingsCache: { getCached: jest.fn() },
}));
jest.mock('./lint_overrides', () => ({
  buildOverridesFromSettings: jest.fn(),
}));
jest.mock('../antlr/opensearch_ppl/ppl_grammar_cache', () => ({
  deriveIsCalcite: jest.fn(),
  shouldUseRuntimeGrammar: jest.fn(),
}));

const mockGetCached = calciteSettingsCache.getCached as jest.Mock;
const mockBuildOverrides = buildOverridesFromSettings as jest.Mock;
const mockDeriveIsCalcite = deriveIsCalcite as jest.Mock;
const mockShouldUseRuntimeGrammar = shouldUseRuntimeGrammar as jest.Mock;

const mockUiSettingsGet = jest.fn();
const mockAddSuccess = jest.fn();
const mockAddWarning = jest.fn();
const services = {
  uiSettings: ({ get: mockUiSettingsGet } as unknown) as IUiSettingsClient,
  http: {} as HttpSetup,
  notifications: ({
    toasts: { addSuccess: mockAddSuccess, addWarning: mockAddWarning },
  } as unknown) as NotificationsStart,
};

const dataset = {
  id: 'dataset-1',
  title: 'accounts',
  dataSource: { id: 'mds-1', version: '3.8.0' },
};

const fullCache: LintFieldsCache = {
  datasetId: 'dataset-1',
  fields: new Set(['a', 'b']),
  typeMap: new Map([['a', 'text']]),
  disabledObjectFields: new Set(['obj']),
  visibleIndices: ['idx-1'],
};

describe('buildPPLLintContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShouldUseRuntimeGrammar.mockReturnValue(true);
    mockDeriveIsCalcite.mockReturnValue(undefined);
    mockBuildOverrides.mockReturnValue({ 'some-rule': { enabled: false } });
    mockGetCached.mockReturnValue(undefined);
    // ENABLE_AI_FEATURES defaults to true; the builder reads it via uiSettings.get.
    mockUiSettingsGet.mockReturnValue(true);
  });

  it('derives dataSourceId/version from the dataset and carries http + overrides', () => {
    const ctx = buildPPLLintContext(dataset, fullCache, services);
    expect(ctx.dataSourceId).toBe('mds-1');
    expect(ctx.dataSourceVersion).toBe('3.8.0');
    expect(ctx.http).toBe(services.http);
    expect(ctx.overrides).toEqual({ 'some-rule': { enabled: false } });
    expect(mockBuildOverrides).toHaveBeenCalledWith(services.uiSettings);
  });

  it('carries datasetTitle and the AI-features flag for the AI quick-fix', () => {
    const ctx = buildPPLLintContext(dataset, fullCache, services);
    expect(ctx.datasetTitle).toBe('accounts');
    expect(ctx.enableAIFeatures).toBe(true);
  });

  it('reports enableAIFeatures false when the uiSetting is off', () => {
    mockUiSettingsGet.mockReturnValue(false);
    const ctx = buildPPLLintContext(dataset, fullCache, services);
    expect(ctx.enableAIFeatures).toBe(false);
  });

  it('feeds cached field metadata when the cache matches the active dataset', () => {
    const ctx = buildPPLLintContext(dataset, fullCache, services);
    expect(ctx.fields).toBe(fullCache.fields);
    expect(ctx.typeMap).toBe(fullCache.typeMap);
    expect(ctx.disabledObjectFields).toBe(fullCache.disabledObjectFields);
    expect(ctx.visibleIndices).toBe(fullCache.visibleIndices);
  });

  it('omits field metadata when the cache belongs to a different dataset', () => {
    const staleCache: LintFieldsCache = { ...fullCache, datasetId: 'other-dataset' };
    const ctx = buildPPLLintContext(dataset, staleCache, services);
    expect(ctx.fields).toBeUndefined();
    expect(ctx.typeMap).toBeUndefined();
    expect(ctx.disabledObjectFields).toBeUndefined();
    expect(ctx.visibleIndices).toBeUndefined();
  });

  it('prefers the cached calcite settings over the version heuristic', () => {
    mockGetCached.mockReturnValue({ isCalcite: true, allJoinTypesAllowed: true });
    mockDeriveIsCalcite.mockReturnValue(false);
    const ctx = buildPPLLintContext(dataset, fullCache, services);
    expect(ctx.isCalcite).toBe(true);
    expect(ctx.settings).toEqual({ allJoinTypesAllowed: true });
  });

  it('falls back to deriveIsCalcite and a non-permissive join setting without cached calcite', () => {
    mockGetCached.mockReturnValue(undefined);
    mockDeriveIsCalcite.mockReturnValue(true);
    const ctx = buildPPLLintContext(dataset, fullCache, services);
    expect(mockDeriveIsCalcite).toHaveBeenCalledWith('3.8.0');
    expect(ctx.isCalcite).toBe(true);
    expect(ctx.settings).toEqual({ allJoinTypesAllowed: false });
  });

  it('handles an undefined dataset (no source selected)', () => {
    const ctx = buildPPLLintContext(undefined, {}, services);
    expect(ctx.dataSourceId).toBeUndefined();
    expect(ctx.dataSourceVersion).toBeUndefined();
    expect(ctx.fields).toBeUndefined();
    // No dataset → no index for the AI fix; the action self-suppresses.
    expect(ctx.datasetTitle).toBeUndefined();
  });

  describe('onAiFixOutcome (AI fix user feedback)', () => {
    it('is a function the host wires to notifications.toasts', () => {
      const ctx = buildPPLLintContext(dataset, fullCache, services);
      expect(typeof ctx.onAiFixOutcome).toBe('function');
    });

    it('raises a success toast on applied', () => {
      buildPPLLintContext(dataset, fullCache, services).onAiFixOutcome?.({ status: 'applied' });
      expect(mockAddSuccess).toHaveBeenCalledTimes(1);
      expect(mockAddWarning).not.toHaveBeenCalled();
    });

    it('raises a warning toast on rejected and on error', () => {
      const ctx = buildPPLLintContext(dataset, fullCache, services);
      ctx.onAiFixOutcome?.({ status: 'rejected', reason: 'diagnostic-not-cleared' });
      ctx.onAiFixOutcome?.({ status: 'error', message: 'boom' });
      expect(mockAddWarning).toHaveBeenCalledTimes(2);
    });

    it('raises a warning on a no-agent skip but stays silent on expected skips', () => {
      const ctx = buildPPLLintContext(dataset, fullCache, services);
      ctx.onAiFixOutcome?.({ status: 'skipped', reason: 'no-agent' });
      expect(mockAddWarning).toHaveBeenCalledTimes(1);
      mockAddWarning.mockClear();
      // ai-disabled / no-index are expected silent states (the action wouldn't
      // have shown), so they raise nothing.
      ctx.onAiFixOutcome?.({ status: 'skipped', reason: 'ai-disabled' });
      ctx.onAiFixOutcome?.({ status: 'skipped', reason: 'no-index' });
      expect(mockAddWarning).not.toHaveBeenCalled();
    });
  });
});
