/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import * as osdMonaco from '@osd/monaco';
import React from 'react';
import { PPLLintFixToolRegistration } from './ppl_lint_fix_tool_registration';
import {
  clearPPLLintFixSession,
  getPPLLintFixOutcome,
  PPL_LINT_FIX_DATA_TOOL_NAME,
  storePPLLintFixSession,
} from './ppl_lint_fix_session';

jest.mock('@osd/monaco', () => ({
  validatePPLLintFixCandidate: jest.fn(),
}));

const mockValidate = (osdMonaco as any).validatePPLLintFixCandidate as jest.Mock;

describe('PPLLintFixToolRegistration', () => {
  const queryState = {
    query: 'source=logs | where status = 500',
    language: 'PPL',
    dataset: { id: 'dataset-1', type: 'INDEX_PATTERN' },
  };
  const request = {
    requestId: 'request-1',
    sourceQueryHash: 'hash-1',
    modelUri: 'file://model-1',
    query: queryState.query,
    diagnostic: { message: 'Unknown field status', ruleId: 'field-validation' },
    datasetTitle: 'logs',
    dataSourceId: 'ds-1',
    chatMessage: 'Fix this query',
    lintContext: { fields: new Set(['status_code']) },
  };

  let queryString: { getQuery: jest.Mock; setQuery: jest.Mock };
  let mockUseAssistantAction: jest.Mock;

  const renderRegistration = () => {
    render(
      <PPLLintFixToolRegistration
        queryString={queryString as any}
        useAssistantAction={mockUseAssistantAction as any}
      />
    );
    return mockUseAssistantAction.mock.calls[0][0];
  };

  const storeSession = (overrides: Partial<Parameters<typeof storePPLLintFixSession>[0]> = {}) => {
    storePPLLintFixSession({
      request: request as any,
      getCurrentQuery: jest.fn(() => request.query),
      getCurrentQueryState: jest.fn(() => queryState as any),
      getLintContext: jest.fn(() => ({ fields: new Set(['fallback']) } as any)),
      ...overrides,
    });
  };

  beforeEach(() => {
    queryString = {
      getQuery: jest.fn(() => queryState),
      setQuery: jest.fn(),
    };
    mockUseAssistantAction = jest.fn();
    mockValidate.mockReset();
    clearPPLLintFixSession();
  });

  afterEach(() => {
    clearPPLLintFixSession();
  });

  it('registers the data-host apply tool with confirmation and a custom renderer', () => {
    const config = renderRegistration();

    expect(mockUseAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: PPL_LINT_FIX_DATA_TOOL_NAME,
        requiresConfirmation: true,
        useCustomRenderer: true,
        parameters: expect.objectContaining({
          // Only fixedQuery is required: the model no longer echoes a
          // requestId/sourceQueryHash — the UI tracks the single active request.
          required: ['fixedQuery'],
        }),
        handler: expect.any(Function),
        render: expect.any(Function),
      })
    );
    expect(config.name).toBe('apply_ppl_lint_fix_data');
  });

  it('rejects a missing active request', async () => {
    const config = renderRegistration();

    const result = await config.handler({
      requestId: 'request-1',
      sourceQueryHash: 'hash-1',
      fixedQuery: 'source=logs | where status_code = 500',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        reason: 'missing-request',
      })
    );
    expect(queryString.setQuery).not.toHaveBeenCalled();
  });

  it('ignores a wrong model-provided sourceQueryHash and applies against the active session', async () => {
    // Hash-matching was removed by design: the handler trusts the single active
    // session (staleness is checked against the live editor query), so a bogus
    // hash from a weak model must NOT block a valid fix.
    storeSession();
    mockValidate.mockReturnValue({ accepted: true });
    const config = renderRegistration();

    const result = await config.handler({
      requestId: 'wrong-id',
      sourceQueryHash: 'hash-2',
      fixedQuery: 'source=logs | where status_code = 500',
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(queryString.setQuery).toHaveBeenCalled();
  });

  it('rejects a stale editor query', async () => {
    storeSession({ getCurrentQuery: jest.fn(() => 'source=logs | head 10') });
    const config = renderRegistration();

    const result = await config.handler({
      requestId: 'request-1',
      sourceQueryHash: 'hash-1',
      fixedQuery: 'source=logs | where status_code = 500',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        reason: 'stale-query',
      })
    );
    expect(queryString.setQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid candidate', async () => {
    storeSession();
    mockValidate.mockReturnValue({ accepted: false, reason: 'syntax-error' });
    const config = renderRegistration();

    const result = await config.handler({
      requestId: 'request-1',
      sourceQueryHash: 'hash-1',
      fixedQuery: 'source=logs | where',
    });

    expect(mockValidate).toHaveBeenCalledWith({
      originalQuery: request.query,
      fixedQuery: 'source=logs | where',
      ruleId: 'field-validation',
      lintContext: request.lintContext,
    });
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        reason: 'invalid-candidate',
        validationReason: 'syntax-error',
      })
    );
    expect(queryString.setQuery).not.toHaveBeenCalled();
  });

  it('applies a valid candidate through queryString.setQuery with force', async () => {
    storeSession();
    mockValidate.mockReturnValue({ accepted: true });
    const config = renderRegistration();

    const result = await config.handler({
      requestId: 'request-1',
      sourceQueryHash: 'hash-1',
      fixedQuery: ' source=logs | where status_code = 500 ',
      explanation: 'Use the mapped field name.',
    });

    expect(queryString.setQuery).toHaveBeenCalledWith(
      {
        ...queryState,
        query: 'source=logs | where status_code = 500',
        language: 'PPL',
        dataset: queryState.dataset,
      },
      true
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        fixedQuery: 'source=logs | where status_code = 500',
      })
    );
  });

  it('renderer wires Apply and Dismiss actions', () => {
    storeSession();
    const config = renderRegistration();
    const onApprove = jest.fn();
    const onReject = jest.fn();

    render(
      <>
        {config.render({
          status: 'executing',
          args: {
            requestId: 'request-1',
            sourceQueryHash: 'hash-1',
            fixedQuery: 'source=logs | where status_code = 500',
            explanation: 'Use the mapped field name.',
          },
          onApprove,
          onReject,
        })}
      </>
    );

    expect(screen.getByText('Unknown field status')).toBeInTheDocument();
    expect(screen.getByText('source=logs | where status_code = 500')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Apply to editor'));
    fireEvent.click(screen.getByText('Dismiss'));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('flips the card to "Fix dismissed" the moment Dismiss is clicked', () => {
    storeSession();
    const config = renderRegistration();

    render(
      <>
        {config.render({
          status: 'executing',
          args: {
            requestId: 'request-1',
            sourceQueryHash: 'hash-1',
            fixedQuery: 'source=logs | where status_code = 500',
          },
          onApprove: jest.fn(),
          onReject: jest.fn(),
        })}
      </>
    );

    // Buttons up, no terminal message yet.
    expect(screen.getByText('Apply to editor')).toBeInTheDocument();
    expect(screen.queryByText('Fix dismissed.')).not.toBeInTheDocument();

    // Clicking Dismiss records the outcome locally and the (subscribed) card
    // re-renders to its terminal state without waiting on the AG-UI round-trip.
    fireEvent.click(screen.getByText('Dismiss'));

    expect(getPPLLintFixOutcome()).toEqual({ kind: 'dismissed' });
    expect(screen.getByText('Fix dismissed.')).toBeInTheDocument();
    expect(screen.queryByText('Apply to editor')).not.toBeInTheDocument();
  });

  it('flips the card to applied the moment the handler applies the fix', async () => {
    storeSession();
    mockValidate.mockReturnValue({ accepted: true });
    const config = renderRegistration();

    render(
      <>
        {config.render({
          status: 'executing',
          args: {
            requestId: 'request-1',
            sourceQueryHash: 'hash-1',
            fixedQuery: 'source=logs | where status_code = 500',
          },
          onApprove: jest.fn(),
          onReject: jest.fn(),
        })}
      </>
    );

    // The apply handler runs when the confirmation is approved; it records the
    // applied outcome, which the subscribed card reflects on re-render. Wrap in
    // act() so the subscriber-triggered state update flushes before asserting.
    await act(async () => {
      await config.handler({
        requestId: 'request-1',
        sourceQueryHash: 'hash-1',
        fixedQuery: 'source=logs | where status_code = 500',
      });
    });

    expect(getPPLLintFixOutcome()).toEqual({ kind: 'applied' });
    expect(screen.queryByText('Apply to editor')).not.toBeInTheDocument();
  });
});
