/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  clearPPLLintContext,
  isPPLLintEnabled,
  registerPPLLintBridge,
  resolvePPLLintResult,
  setPPLLintContext,
  setPPLLintEnabled,
} from '../../lint_bridge';
import { LintResult } from '../diagnostic';

describe('PPL lint bridge', () => {
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

  it('uses the registered bridge result when available', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    const fallbackValidate = jest.fn().mockResolvedValue({ isValid: true, errors: [] });
    const fallbackAnalyze = jest.fn().mockResolvedValue({ result: emptyResult });
    const fallbackValidateProbes = jest.fn().mockResolvedValue([true]);
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
    unregister = registerPPLLintBridge(
      ({
        context,
        compiledFallbackLint,
        compiledFallbackValidate,
        compiledFallbackAnalyze,
        compiledFallbackValidateProbes,
      }) => {
        expect(context?.dataSourceId).toBe('ds-1');
        expect(compiledFallbackLint).toBe(fallback);
        expect(compiledFallbackValidate).toBe(fallbackValidate);
        expect(compiledFallbackAnalyze).toBe(fallbackAnalyze);
        expect(compiledFallbackValidateProbes).toBe(fallbackValidateProbes);
        return runtimeResult;
      }
    );

    await expect(
      resolvePPLLintResult(
        model,
        'source=logs',
        fallback,
        fallbackValidate,
        undefined,
        fallbackAnalyze,
        fallbackValidateProbes
      )
    ).resolves.toEqual(runtimeResult);
    expect(fallback).not.toHaveBeenCalled();
    expect(fallbackValidate).not.toHaveBeenCalled();
  });

  it('does not run the fallback again after a bridge uses the fallback callback', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    unregister = registerPPLLintBridge(async ({ content, compiledFallbackLint }) => {
      return compiledFallbackLint!(content);
    });

    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual(
      emptyResult
    );
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith('source=logs');
  });

  it('treats an empty (but non-null) bridge result as complete without fallback', async () => {
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
    unregister = registerPPLLintBridge(() => ({ diagnostics: [] }));
    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual({
      diagnostics: [],
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back when the bridge returns null', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    unregister = registerPPLLintBridge(() => null);
    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual(
      emptyResult
    );
    expect(fallback).toHaveBeenCalledWith('source=logs');
  });

  it('falls back when the bridge throws', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    unregister = registerPPLLintBridge(() => {
      throw new Error('boom');
    });
    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual(
      emptyResult
    );
    expect(fallback).toHaveBeenCalled();
  });

  it('falls back when no bridge is registered', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    await expect(resolvePPLLintResult(model, 'source=logs', fallback)).resolves.toEqual(
      emptyResult
    );
    expect(fallback).toHaveBeenCalled();
  });

  it('unregister removes only the current bridge', async () => {
    const fallback = jest.fn().mockResolvedValue(emptyResult);
    unregister = registerPPLLintBridge(() => ({ diagnostics: [] }));
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
