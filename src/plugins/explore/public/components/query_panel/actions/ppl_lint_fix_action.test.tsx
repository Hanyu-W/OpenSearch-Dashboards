/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { validatePPLLintFixCandidate } from '@osd/monaco';
import { verifyPerformanceFixOutcome } from '../../../../../data/public';
import {
  APPLY_PPL_LINT_FIX_EXPLORE_TOOL_DEFINITION,
  registerDisabledPPLLintFixAction,
  renderPPLLintFixAction,
  usePPLLintFixAction,
} from './ppl_lint_fix_action';
import {
  clearActivePPLLintFixSession,
  getActivePPLLintFixSession,
  setActivePPLLintFixSession,
} from './ppl_lint_fix_session';

const mockRegisterAssistantAction = jest.fn();
const mockSetEditorTextWithQuery = jest.fn();

jest.mock('@osd/monaco', () => ({
  validatePPLLintFixCandidate: jest.fn(),
}));

jest.mock('../../../../../data/public', () => ({
  verifyPerformanceFixOutcome: jest.fn(),
}));

jest.mock('../../../../../opensearch_dashboards_react/public', () => ({
  useOpenSearchDashboards: () => ({
    services: {
      contextProvider: {
        actions: { registerAssistantAction: mockRegisterAssistantAction },
      },
    },
  }),
}));

jest.mock('@elastic/eui', () => ({
  EuiButton: ({ children, onClick, fill, size, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
  EuiButtonEmpty: ({ children, onClick, size, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
  EuiCallOut: ({ title }: any) => <div>{title}</div>,
  EuiCodeBlock: ({ children }: any) => <pre>{children}</pre>,
  EuiFlexGroup: ({ children }: any) => <div>{children}</div>,
  EuiFlexItem: ({ children }: any) => <div>{children}</div>,
  EuiSpacer: () => <div />,
  EuiText: ({ children }: any) => <div>{children}</div>,
}));

const mockValidatePPLLintFixCandidate = jest.mocked(validatePPLLintFixCandidate);
const mockVerifyPerformanceFixOutcome = jest.mocked(verifyPerformanceFixOutcome);

const request = {
  requestId: 'req-1',
  sourceQueryHash: 'hash-1',
  toolName: 'apply_ppl_lint_fix_explore',
  modelUri: 'file://model',
  query: 'source=logs | where status = 500',
  diagnostic: {
    message: 'status is not a known field',
    ruleId: 'unknown-field',
  },
  chatMessage: 'Please fix this query',
  lintContext: {
    fields: new Set(['response_status']),
  } as any,
};

describe('usePPLLintFixAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearActivePPLLintFixSession();
    mockValidatePPLLintFixCandidate.mockReturnValue({ accepted: true });
    mockVerifyPerformanceFixOutcome.mockResolvedValue(true);
  });

  const renderAndGetAction = () => {
    act(() => {
      renderHook(() => usePPLLintFixAction(mockSetEditorTextWithQuery));
    });
    expect(mockRegisterAssistantAction).toHaveBeenCalled();
    return mockRegisterAssistantAction.mock.calls[
      mockRegisterAssistantAction.mock.calls.length - 1
    ][0];
  };

  const setSession = (currentQuery = request.query) => {
    setActivePPLLintFixSession({
      request,
      getCurrentQuery: () => currentQuery,
      getLintContext: () =>
        ({
          fields: new Set(['response_status']),
        } as any),
    });
  };

  it('registers the Explore-specific fix action with confirmation and custom rendering', () => {
    const action = renderAndGetAction();

    expect(action.name).toBe('apply_ppl_lint_fix_explore');
    expect(action.requiresConfirmation).toBe(true);
    expect(action.useCustomRenderer).toBe(true);
    // The schema requires only fixedQuery: the model no longer echoes a
    // requestId/sourceQueryHash (weak models filled them wrong and tripped a
    // false mismatch loop). The UI tracks the single active request instead.
    expect(action.parameters.required).toEqual(['fixedQuery']);
    expect(action.render).toBe(renderPPLLintFixAction);
  });

  it('applies a valid candidate through setEditorTextWithQuery', async () => {
    setSession();
    const action = renderAndGetAction();

    const result = await action.handler({
      requestId: 'req-1',
      sourceQueryHash: 'hash-1',
      fixedQuery: 'source=logs | where response_status = 500',
      explanation: 'Use the mapped status field.',
    });

    expect(mockValidatePPLLintFixCandidate).toHaveBeenCalledWith({
      originalQuery: request.query,
      fixedQuery: 'source=logs | where response_status = 500',
      ruleId: 'unknown-field',
      lintContext: request.lintContext,
    });
    expect(mockSetEditorTextWithQuery).toHaveBeenCalledWith(
      'source=logs | where response_status = 500'
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        applied: true,
        requestId: 'req-1',
      })
    );
  });

  it('rejects when there is no active request', async () => {
    const action = renderAndGetAction();

    const result = await action.handler({
      requestId: 'req-1',
      sourceQueryHash: 'hash-1',
      fixedQuery: 'source=logs',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        applied: false,
        reason: 'missing-request',
      })
    );
    expect(mockSetEditorTextWithQuery).not.toHaveBeenCalled();
  });

  it('ignores a wrong model-provided sourceQueryHash and applies against the active session', async () => {
    // Hash-matching was removed by design: the handler trusts the single active
    // session (staleness is checked by comparing the live editor query, below),
    // so a bogus hash from a weak model must NOT block a valid fix.
    setSession();
    const action = renderAndGetAction();

    const result = await action.handler({
      requestId: 'wrong-id',
      sourceQueryHash: 'old-hash',
      fixedQuery: 'source=logs | where response_status = 500',
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, applied: true, requestId: 'req-1' })
    );
    expect(mockSetEditorTextWithQuery).toHaveBeenCalledWith(
      'source=logs | where response_status = 500'
    );
  });

  it('rejects when the editor text changed after the request opened', async () => {
    setSession('source=logs | head 10');
    const action = renderAndGetAction();

    const result = await action.handler({
      requestId: 'req-1',
      sourceQueryHash: 'hash-1',
      fixedQuery: 'source=logs',
    });

    expect(result.reason).toBe('stale-query');
    expect(mockValidatePPLLintFixCandidate).not.toHaveBeenCalled();
    expect(mockSetEditorTextWithQuery).not.toHaveBeenCalled();
  });

  it('rejects invalid candidates without changing the editor', async () => {
    setSession();
    mockValidatePPLLintFixCandidate.mockReturnValue({
      accepted: false,
      reason: 'syntax-error',
    });
    const action = renderAndGetAction();

    const result = await action.handler({
      requestId: 'req-1',
      sourceQueryHash: 'hash-1',
      fixedQuery: 'source=logs | where',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        applied: false,
        reason: 'syntax-error',
      })
    );
    expect(mockVerifyPerformanceFixOutcome).not.toHaveBeenCalled();
    expect(mockSetEditorTextWithQuery).not.toHaveBeenCalled();
  });

  it('revalidates a 3.5 performance fix before applying only the attributed edit', async () => {
    const originalQuery =
      'source=logs* | where droppedAttributesCount + 10 > 20 | ' + 'where severityNumber - 10 > 20';
    const fixedQuery =
      'source=logs* | where droppedAttributesCount > 10 | ' + 'where severityNumber - 10 > 20';
    const targetText = 'droppedAttributesCount + 10 > 20';
    const startOffset = originalQuery.indexOf(targetText);
    const lintContext = {
      useRuntimeGrammar: false,
      dataSourceVersion: '3.5.0',
      dataSourceId: 'fidelity-test-cluster-os35',
      http: { post: jest.fn() },
    } as any;
    const performanceRequest = {
      ...request,
      query: originalQuery,
      lintContext,
      diagnostic: {
        message: 'This filter runs as a script.',
        ruleId: 'operation-pushed-as-script',
        operation: 'filter',
        outcome: 'filter:script',
        targetText,
        targetRange: {
          startOffset,
          endOffset: startOffset + targetText.length,
        },
      },
    } as any;
    const session = {
      request: performanceRequest,
      getCurrentQuery: () => originalQuery,
      getLintContext: () => lintContext,
    };
    let currentDuringValidation = false;
    mockVerifyPerformanceFixOutcome.mockImplementationOnce(
      async (_original, _fixed, _diagnostic, _context, isCurrent) => {
        currentDuringValidation = isCurrent();
        return true;
      }
    );
    setActivePPLLintFixSession(session);
    const action = renderAndGetAction();

    const result = await action.handler({ fixedQuery });

    expect(mockVerifyPerformanceFixOutcome).toHaveBeenCalledWith(
      originalQuery,
      fixedQuery,
      performanceRequest.diagnostic,
      lintContext,
      expect.any(Function)
    );
    expect(currentDuringValidation).toBe(true);
    expect(mockSetEditorTextWithQuery).toHaveBeenCalledWith(fixedQuery);
    expect(result).toEqual(expect.objectContaining({ success: true, applied: true }));
  });

  it('rejects a performance fix that does not clear the attributed outcome', async () => {
    setSession();
    mockVerifyPerformanceFixOutcome.mockResolvedValue(false);
    const action = renderAndGetAction();

    const result = await action.handler({
      fixedQuery: 'source=logs | where response_status = 500',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        applied: false,
        reason: 'invalid-candidate',
      })
    );
    expect(mockSetEditorTextWithQuery).not.toHaveBeenCalled();
  });

  it('rejects when the editor changes during performance revalidation', async () => {
    let currentQuery = request.query;
    let finishValidation!: (value: boolean) => void;
    mockVerifyPerformanceFixOutcome.mockReturnValueOnce(
      new Promise((resolve) => {
        finishValidation = resolve;
      })
    );
    setActivePPLLintFixSession({
      request,
      getCurrentQuery: () => currentQuery,
      getLintContext: () => request.lintContext as any,
    });
    const action = renderAndGetAction();

    const resultPromise = action.handler({
      fixedQuery: 'source=logs | where response_status = 500',
    });
    currentQuery = 'source=logs | head 10';
    finishValidation(true);

    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({
        success: false,
        applied: false,
        reason: 'stale-query',
      })
    );
    expect(mockSetEditorTextWithQuery).not.toHaveBeenCalled();
  });

  it('registers a disabled placeholder and clears the session on unmount', () => {
    setSession();
    const { unmount } = renderHook(() => usePPLLintFixAction(mockSetEditorTextWithQuery));

    unmount();

    expect(mockRegisterAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'apply_ppl_lint_fix_explore',
        available: 'disabled',
      })
    );
    expect(getActivePPLLintFixSession()).toBeUndefined();
  });
});

describe('APPLY_PPL_LINT_FIX_EXPLORE_TOOL_DEFINITION', () => {
  it('uses the Explore-specific action name', () => {
    expect(APPLY_PPL_LINT_FIX_EXPLORE_TOOL_DEFINITION.name).toBe('apply_ppl_lint_fix_explore');
  });
});

describe('registerDisabledPPLLintFixAction', () => {
  it('registers a disabled action whose handler tells Olly to stop tool calls', async () => {
    const registerAction = jest.fn();

    registerDisabledPPLLintFixAction(registerAction);

    const disabledAction = registerAction.mock.calls[0][0];
    const result = await disabledAction.handler({});

    expect(disabledAction.name).toBe('apply_ppl_lint_fix_explore');
    expect(disabledAction.available).toBe('disabled');
    expect(result.success).toBe(false);
    expect(result.stop_tool_execution).toBe(true);
    expect(result.context_lost).toBe(true);
    expect(result.message).toContain('Do not attempt to use any more tools');
  });
});

describe('renderPPLLintFixAction', () => {
  it('renders the proposed query and wires apply/dismiss callbacks', () => {
    const onApprove = jest.fn();
    const onReject = jest.fn();

    render(
      <>
        {renderPPLLintFixAction({
          status: 'pending',
          args: {
            requestId: 'req-1',
            sourceQueryHash: 'hash-1',
            fixedQuery: 'source=logs | where response_status = 500',
            explanation: 'Use the mapped status field.',
          },
          onApprove,
          onReject,
        })}
      </>
    );

    expect(screen.getByText('Apply suggested fix')).toBeInTheDocument();
    expect(screen.getByText('Use the mapped status field.')).toBeInTheDocument();
    expect(screen.getByText('source=logs | where response_status = 500')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pplLintFixExploreApplyButton'));
    fireEvent.click(screen.getByTestId('pplLintFixExploreDismissButton'));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('uses the short product message for a performance fix card', () => {
    setActivePPLLintFixSession({
      request: {
        ...request,
        diagnostic: {
          message:
            'This filter may be slow because it does extra calculations. Compare the field directly instead.',
          ruleId: 'operation-pushed-as-script',
        },
      },
      getCurrentQuery: () => request.query,
      getLintContext: () => request.lintContext,
    });

    const props = {
      status: 'pending' as const,
      args: {
        requestId: 'wrong-id',
        fixedQuery: 'source=logs | where bytes > 6000',
        explanation: 'Detailed engine-specific explanation that should not be shown.',
      },
    };
    const rendered = render(<>{renderPPLLintFixAction(props)}</>);

    expect(
      screen.getByText(
        'This filter may be slow because it does extra calculations. Compare the field directly instead.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Detailed engine-specific explanation that should not be shown.')
    ).not.toBeInTheDocument();

    clearActivePPLLintFixSession();
    rendered.rerender(<>{renderPPLLintFixAction({ ...props, status: 'complete' as const })}</>);

    expect(
      screen.getByText(
        'This filter may be slow because it does extra calculations. Compare the field directly instead.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Detailed engine-specific explanation that should not be shown.')
    ).not.toBeInTheDocument();
  });
});
