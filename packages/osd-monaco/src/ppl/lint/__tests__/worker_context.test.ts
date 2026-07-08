/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { hydrateWorkerLintContext, toWorkerLintContextPayload } from '../worker_context';

describe('worker lint context payload', () => {
  it('serializes only structured-clone-safe host lint context', () => {
    const overrides = { 'head-without-sort': { enabled: false } };
    const payload = toWorkerLintContextPayload({
      useRuntimeGrammar: true,
      dataSourceId: 'ds-1',
      dataSourceVersion: '3.5.0',
      isCalcite: true,
      fields: new Set(['body', 'status']),
      typeMap: new Map([
        ['body', 'text'],
        ['status', 'keyword'],
      ]),
      disabledObjectFields: new Set(['raw']),
      visibleIndices: ['logs-2026'],
      settings: { allJoinTypesAllowed: true },
      overrides,
      http: { post: jest.fn() },
    } as any);

    expect(payload).toEqual({
      dataSourceId: 'ds-1',
      dataSourceVersion: '3.5.0',
      isCalcite: true,
      fields: ['body', 'status'],
      typeMap: [
        ['body', 'text'],
        ['status', 'keyword'],
      ],
      disabledObjectFields: ['raw'],
      visibleIndices: ['logs-2026'],
      settings: { allJoinTypesAllowed: true },
      overrides,
    });
    expect(payload).not.toHaveProperty('http');
    expect(payload).not.toHaveProperty('useRuntimeGrammar');
  });

  it('hydrates worker payload arrays back into Set and Map values', () => {
    const context = hydrateWorkerLintContext({
      dataSourceId: 'ds-1',
      dataSourceVersion: '3.5.0',
      isCalcite: true,
      fields: ['body'],
      typeMap: [['body', 'text']],
      disabledObjectFields: ['raw'],
      visibleIndices: ['logs-2026'],
      settings: { allJoinTypesAllowed: true },
      overrides: { 'field-validation': { enabled: false } },
    });

    expect(context?.fields).toBeInstanceOf(Set);
    expect(context?.fields?.has('body')).toBe(true);
    expect(context?.typeMap).toBeInstanceOf(Map);
    expect(context?.typeMap?.get('body')).toBe('text');
    expect(context?.disabledObjectFields).toBeInstanceOf(Set);
    expect(context?.disabledObjectFields?.has('raw')).toBe(true);
    expect(context?.visibleIndices).toEqual(['logs-2026']);
    expect(context?.settings).toEqual({ allJoinTypesAllowed: true });
  });

  it('returns undefined when no context exists', () => {
    expect(toWorkerLintContextPayload(undefined)).toBeUndefined();
    expect(hydrateWorkerLintContext(undefined)).toBeUndefined();
  });
});
