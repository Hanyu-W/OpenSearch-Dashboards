/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  clearPPLLintContext,
  isPPLLintEnabled,
  registerPPLLintProvider,
  resolvePPLLintResult,
  setPPLLintContext,
  setPPLLintEnabled,
} from '../../lint_provider';
import { LintResult } from '../diagnostic';

describe('PPL lint provider bridge', () => {
  let model: any;
  let unregister: (() => void) | undefined;
  const emptyResult: LintResult = { diagnostics: [] };

  beforeEach(() => {
    model = {};
    unregister = undefined;
  });

  afterEach(() => {
    unregister?.();
    clearPPLLintContext(model);
  });

  it('uses the registered provider result when available', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    const runtimeResult: LintResult = {
      diagnostics: [
        {
          ruleId: 'r',
          severity: 'error',
          message: 'm',
          range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
        },
      ],
    };
    setPPLLintContext(model, { useRuntimeGrammar: true, dataSourceId: 'ds-1' });
    unregister = registerPPLLintProvider(({ context }) => {
      expect(context?.dataSourceId).toBe('ds-1');
      return runtimeResult;
    });

    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual(
      runtimeResult
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it('treats an empty (but non-null) provider result as complete without fallback', async () => {
    const fallback = jest.fn().mockResolvedValue({
      diagnostics: [
        {
          ruleId: 'fallback',
          severity: 'error',
          message: 'x',
          range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
        },
      ],
    });
    unregister = registerPPLLintProvider(() => ({ diagnostics: [] }));
    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual({
      diagnostics: [],
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back when the provider returns null', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    unregister = registerPPLLintProvider(() => null);
    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual(
      emptyResult
    );
    expect(fallback).toHaveBeenCalledWith('source=logs');
  });

  it('falls back when the provider throws', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    unregister = registerPPLLintProvider(() => {
      throw new Error('boom');
    });
    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual(
      emptyResult
    );
    expect(fallback).toHaveBeenCalled();
  });

  it('falls back when no provider is registered', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual(
      emptyResult
    );
    expect(fallback).toHaveBeenCalled();
  });

  it('unregister removes only the current provider', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    unregister = registerPPLLintProvider(() => ({ diagnostics: [] }));
    unregister();
    unregister = undefined;
    await resolvePPLLintResult(model, 'source=logs', fallback);
    expect(fallback).toHaveBeenCalled();
  });

  it('toggles the enabled flag', () => {
    setPPLLintEnabled(false);
    expect(isPPLLintEnabled()).toBe(false);
    setPPLLintEnabled(true);
    expect(isPPLLintEnabled()).toBe(true);
  });
});
