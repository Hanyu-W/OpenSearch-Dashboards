/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCodeBlock,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { i18n } from '@osd/i18n';
import { useMount, useUnmount } from 'react-use';
import { validatePPLLintFixCandidate } from '@osd/monaco';
import { useOpenSearchDashboards } from '../../../../../opensearch_dashboards_react/public';
import { ExploreServices } from '../../../types';
import { useSetEditorTextWithQuery } from '../../../application/hooks';
import {
  APPLY_PPL_LINT_FIX_EXPLORE_TOOL_NAME,
  clearActivePPLLintFixSession,
  getActivePPLLintFixSession,
} from './ppl_lint_fix_session';

interface ApplyPPLLintFixArgs {
  requestId: string;
  sourceQueryHash: string;
  fixedQuery: string;
  explanation?: string;
}

interface PPLLintFixRenderProps {
  status: 'pending' | 'executing' | 'complete' | 'failed';
  args?: ApplyPPLLintFixArgs;
  result?: any;
  error?: Error;
  onApprove?: () => void;
  onReject?: () => void;
}

const buildFailureResult = (
  requestId: string | undefined,
  reason: string,
  message: string,
  extra?: Record<string, unknown>
) => ({
  success: false,
  applied: false,
  requestId,
  reason,
  message,
  error: message,
  ...extra,
});

export const APPLY_PPL_LINT_FIX_EXPLORE_TOOL_DEFINITION = {
  name: APPLY_PPL_LINT_FIX_EXPLORE_TOOL_NAME,
  description:
    'Proposes a corrected OpenSearch PPL query for the active Explore lint-fix request. This tool does not execute the query. The UI will ask the user to approve before the editor is updated.',
  parameters: {
    type: 'object' as const,
    properties: {
      requestId: {
        type: 'string',
        description: 'The active PPL lint fix request id.',
      },
      sourceQueryHash: {
        type: 'string',
        description: 'The source query hash from the active lint fix request.',
      },
      fixedQuery: {
        type: 'string',
        description: 'The proposed corrected OpenSearch PPL query.',
      },
      explanation: {
        type: 'string',
        description: 'A short explanation of the correction.',
      },
    },
    required: ['requestId', 'sourceQueryHash', 'fixedQuery'],
  },
  requiresConfirmation: true,
  useCustomRenderer: true,
};

export function registerDisabledPPLLintFixAction(
  registerAction: (action: any) => void | undefined
) {
  if (!registerAction) return;

  registerAction({
    ...APPLY_PPL_LINT_FIX_EXPLORE_TOOL_DEFINITION,
    available: 'disabled',
    handler: async () =>
      buildFailureResult(
        undefined,
        'context-lost',
        'STOP: Tool not available - Explore query panel context has changed',
        {
          stop_tool_execution: true,
          context_lost: true,
          message:
            'IMPORTANT: The apply_ppl_lint_fix_explore tool is no longer available because the user has navigated away from the Explore query panel. Do not attempt to use any more tools. Respond directly to the user and explain that the fix cannot be applied because the Explore query panel is no longer active.',
        }
      ),
    render: renderPPLLintFixAction,
  });
}

export function renderPPLLintFixAction({
  status,
  args,
  result,
  error,
  onApprove,
  onReject,
}: PPLLintFixRenderProps) {
  const session = args?.requestId ? getActivePPLLintFixSession(args.requestId) : undefined;
  const diagnostic = session?.request.diagnostic;
  const statusMessage = result?.message ?? error?.message;

  return (
    <div data-test-subj="pplLintFixExploreActionRenderer">
      <EuiText size="s">
        <strong>
          {i18n.translate('explore.pplLintFixAction.title', {
            defaultMessage: 'Apply PPL lint fix',
          })}
        </strong>
        {diagnostic?.message ? <p>{diagnostic.message}</p> : null}
        {args?.explanation ? <p>{args.explanation}</p> : null}
      </EuiText>

      {args?.fixedQuery ? (
        <>
          <EuiSpacer size="s" />
          <EuiCodeBlock language="ppl" paddingSize="s" isCopyable={true}>
            {args.fixedQuery}
          </EuiCodeBlock>
        </>
      ) : null}

      {status === 'pending' || status === 'executing' ? (
        <>
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                fill={true}
                onClick={onApprove}
                data-test-subj="pplLintFixExploreApplyButton"
              >
                {i18n.translate('explore.pplLintFixAction.applyButton', {
                  defaultMessage: 'Apply to editor',
                })}
              </EuiButton>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                size="s"
                onClick={onReject}
                data-test-subj="pplLintFixExploreDismissButton"
              >
                {i18n.translate('explore.pplLintFixAction.dismissButton', {
                  defaultMessage: 'Dismiss',
                })}
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ) : null}

      {status === 'complete' ? (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            size="s"
            color="success"
            title={i18n.translate('explore.pplLintFixAction.complete', {
              defaultMessage: 'Query updated.',
            })}
          />
        </>
      ) : null}

      {status === 'failed' ? (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            size="s"
            color="danger"
            title={
              statusMessage ??
              i18n.translate('explore.pplLintFixAction.failed', {
                defaultMessage: 'The proposed fix could not be applied.',
              })
            }
          />
        </>
      ) : null}
    </div>
  );
}

export function usePPLLintFixAction(
  setEditorTextWithQuery: ReturnType<typeof useSetEditorTextWithQuery>
) {
  const { services } = useOpenSearchDashboards<ExploreServices>();
  const registerAction = services.contextProvider?.actions?.registerAssistantAction;

  useMount(() => {
    if (!registerAction) return;

    registerAction({
      ...APPLY_PPL_LINT_FIX_EXPLORE_TOOL_DEFINITION,
      handler: async (args: ApplyPPLLintFixArgs = {} as ApplyPPLLintFixArgs) => {
        try {
          const session = getActivePPLLintFixSession();
          if (!session) {
            return buildFailureResult(
              args?.requestId,
              'missing-request',
              'No active Explore PPL lint fix request was found.'
            );
          }

          if (session.request.requestId !== args.requestId) {
            return buildFailureResult(
              args.requestId,
              'stale-request',
              'The active Explore PPL lint fix request has changed.'
            );
          }

          if (session.request.sourceQueryHash !== args.sourceQueryHash) {
            return buildFailureResult(
              args.requestId,
              'hash-mismatch',
              'The proposed fix does not match the active source query hash.'
            );
          }

          const currentQuery = session.getCurrentQuery() ?? '';
          if (currentQuery !== session.request.query) {
            return buildFailureResult(
              args.requestId,
              'stale-query',
              'The query changed after the fix request was opened. Ask for a fresh fix.'
            );
          }

          const fixedQuery = args.fixedQuery.trim();
          const validation = validatePPLLintFixCandidate({
            originalQuery: session.request.query,
            fixedQuery,
            ruleId: session.request.diagnostic.ruleId,
            lintContext: session.request.lintContext ?? session.getLintContext(),
          });

          if (!validation.accepted) {
            return buildFailureResult(
              args.requestId,
              validation.reason ?? 'invalid-candidate',
              'The proposed fix did not pass PPL lint validation.',
              { validation }
            );
          }

          setEditorTextWithQuery(fixedQuery);
          clearActivePPLLintFixSession(args.requestId);

          return {
            success: true,
            applied: true,
            requestId: args.requestId,
            query: fixedQuery,
            message: 'Applied the PPL lint fix to the Explore query editor.',
          };
        } catch (handlerError) {
          return buildFailureResult(
            args?.requestId,
            'unexpected-error',
            handlerError instanceof Error ? handlerError.message : 'Unknown error'
          );
        }
      },
      render: renderPPLLintFixAction,
    });
  });

  useUnmount(() => {
    if (registerAction) {
      registerDisabledPPLLintFixAction(registerAction);
    }
    clearActivePPLLintFixSession();
  });
}
