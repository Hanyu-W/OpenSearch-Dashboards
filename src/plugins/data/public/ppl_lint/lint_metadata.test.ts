/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpSetup } from '../../../../core/public';
import { calciteSettingsCache } from './calcite_settings';
import { isPPLLintEnabled, loadPPLLintFields, resolvePPLLintSettings } from './lint_metadata';

describe('PPL lint metadata gating', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requires the capability to be exactly true', () => {
    expect(isPPLLintEnabled()).toBe(false);
    expect(isPPLLintEnabled({ queryEnhancements: { pplLint: false } })).toBe(false);
    expect(isPPLLintEnabled({ queryEnhancements: { pplLint: 'true' } })).toBe(false);
    expect(isPPLLintEnabled({ queryEnhancements: { pplLint: true } })).toBe(true);
  });

  it('performs no lint-only requests when disabled', async () => {
    const getIndexPattern = jest.fn();
    const http = ({ get: jest.fn() } as unknown) as HttpSetup;
    const settings = jest.spyOn(calciteSettingsCache, 'resolve');

    await expect(
      loadPPLLintFields({
        enabled: false,
        datasetId: 'logs',
        dataSourceId: 'ds-1',
        getIndexPattern,
        http,
        probeAiAgent: true,
      })
    ).resolves.toEqual({});
    expect(resolvePPLLintSettings(false, http, 'ds-1')).toBeUndefined();

    expect(getIndexPattern).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  });

  it('loads field metadata when enabled', async () => {
    const fields = await loadPPLLintFields({
      enabled: true,
      datasetId: 'logs',
      dataSourceId: 'ds-1',
      getIndexPattern: jest.fn().mockResolvedValue({
        fields: [
          { name: 'status', esTypes: ['keyword'] },
          { name: 'latency', esTypes: ['long'] },
        ],
      }),
      probeAiAgent: false,
    });

    expect(fields.datasetId).toBe('logs');
    expect(fields.fields).toEqual(new Set(['status', 'latency']));
    expect(fields.typeMap).toEqual(
      new Map([
        ['status', 'keyword'],
        ['latency', 'long'],
      ])
    );
  });
});
