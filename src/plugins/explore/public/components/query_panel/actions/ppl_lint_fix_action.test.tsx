/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { validatePPLLintFixCandidate } from '@osd/monaco';
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
    expect(action.parameters.required).toEqual(['requestId', 'sourceQueryHash', 'fixedQuery']);
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

  it('rejects stale source hash requests', async () => {
    setSession();
    const action = renderAndGetAction();

    const result = await action.handler({
      requestId: 'req-1',
      sourceQueryHash: 'old-hash',
      fixedQuery: 'source=logs',
    });

    expect(result.reason).toBe('hash-mismatch');
    expect(mockValidatePPLLintFixCandidate).not.toHaveBeenCalled();
    expect(mockSetEditorTextWithQuery).not.toHaveBeenCalled();
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

    expect(screen.getByText('source=logs | where response_status = 500')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pplLintFixExploreApplyButton'));
    fireEvent.click(screen.getByTestId('pplLintFixExploreDismissButton'));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
