/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { IUiSettingsClient } from 'opensearch-dashboards/public';
import { HttpSetup } from '../../../../core/public';
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

const services = {
  uiSettings: {} as IUiSettingsClient,
  http: {} as HttpSetup,
};

const dataset = {
  id: 'dataset-1',
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
  });

  it('derives dataSourceId/version from the dataset and carries http + overrides', () => {
    const ctx = buildPPLLintContext(dataset, fullCache, services);
    expect(ctx.dataSourceId).toBe('mds-1');
    expect(ctx.dataSourceVersion).toBe('3.8.0');
    expect(ctx.http).toBe(services.http);
    expect(ctx.overrides).toEqual({ 'some-rule': { enabled: false } });
    expect(mockBuildOverrides).toHaveBeenCalledWith(services.uiSettings);
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
  });
});
