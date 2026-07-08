/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EuiButton,
  EuiButtonEmpty,
  EuiCodeBlock,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import { i18n } from '@osd/i18n';
import { validatePPLLintFixCandidate } from '@osd/monaco';
import React from 'react';
import type { ContextProviderStart, RenderProps } from '../../../context_provider/public';
import type { QueryStringContract } from '../query/query_string';
import { getPPLLintFixSession, PPL_LINT_FIX_DATA_TOOL_NAME } from './ppl_lint_fix_session';

export interface PPLLintFixToolArgs {
  requestId: string;
  sourceQueryHash: string;
  fixedQuery: string;
  explanation?: string;
}

interface PPLLintFixToolResult {
  success: boolean;
  message: string;
  reason?: 'missing-request' | 'hash-mismatch' | 'stale-query' | 'invalid-candidate';
  validationReason?: string;
  fixedQuery?: string;
}

interface PPLLintFixToolRegistrationProps {
  queryString: QueryStringContract;
  useAssistantAction?: ContextProviderStart['hooks']['useAssistantAction'];
}

const noopUseAssistantAction: ContextProviderStart['hooks']['useAssistantAction'] = () => {};

const failure = (
  reason: NonNullable<PPLLintFixToolResult['reason']>,
  message: string,
  extra?: Pick<PPLLintFixToolResult, 'validationReason'>
): PPLLintFixToolResult => ({
  success: false,
  reason,
  message,
  ...extra,
});

export const PPLLintFixToolRegistration: React.FC<PPLLintFixToolRegistrationProps> = ({
  queryString,
  useAssistantAction,
}) => {
  const useAssistantActionHook = useAssistantAction || noopUseAssistantAction;

  useAssistantActionHook<PPLLintFixToolArgs>({
    name: PPL_LINT_FIX_DATA_TOOL_NAME,
    description:
      'Proposes a corrected OpenSearch PPL query for the active data editor lint-fix request. This tool does not execute the query. The UI will ask the user to approve before the editor is updated.',
    parameters: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'The active PPL lint fix request id.',
        },
        sourceQueryHash: {
          type: 'string',
          description: 'The source query hash from the lint fix request.',
        },
        fixedQuery: {
          type: 'string',
          description: 'The complete corrected OpenSearch PPL query.',
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
    handler: async (args) => {
      if (!args?.requestId) {
        return failure(
          'missing-request',
          'The active PPL lint fix request is no longer available.'
        );
      }

      const session = getPPLLintFixSession(args.requestId);
      if (!session) {
        return failure(
          'missing-request',
          'The active PPL lint fix request is no longer available.'
        );
      }

      if (args.sourceQueryHash !== session.request.sourceQueryHash) {
        return failure(
          'hash-mismatch',
          'The proposed fix does not match the active PPL lint fix request.'
        );
      }

      const currentQueryText = session.getCurrentQuery() ?? '';
      if (currentQueryText !== session.request.query) {
        return failure(
          'stale-query',
          'The editor changed after this PPL lint fix request was created.'
        );
      }

      if (typeof args.fixedQuery !== 'string') {
        return failure('invalid-candidate', 'The proposed PPL query is missing.');
      }

      const fixedQuery = args.fixedQuery.trim();
      const validation = validatePPLLintFixCandidate({
        originalQuery: session.request.query,
        fixedQuery,
        ruleId: session.request.diagnostic.ruleId,
        lintContext: session.request.lintContext ?? session.getLintContext(),
      });

      if (!validation.accepted) {
        return failure(
          'invalid-candidate',
          `The proposed query did not pass PPL lint validation: ${validation.reason || 'unknown'}.`,
          { validationReason: validation.reason }
        );
      }

      const currentQuery = session.getCurrentQueryState();
      queryString.setQuery(
        {
          ...currentQuery,
          query: fixedQuery,
          language: currentQuery.language || 'PPL',
          dataset: currentQuery.dataset,
        },
        true
      );

      return {
        success: true,
        message: 'Applied the PPL lint fix to the data editor.',
        fixedQuery,
      };
    },
    render: (renderProps) => <PPLLintFixToolRenderer {...renderProps} />,
  });

  return null;
};

const PPLLintFixToolRenderer: React.FC<RenderProps<PPLLintFixToolArgs>> = ({
  status,
  args,
  result,
  onApprove,
  onReject,
}) => {
  const session = args?.requestId ? getPPLLintFixSession(args.requestId) : undefined;
  const showActions = (status === 'pending' || status === 'executing') && !!args;
  const failedMessage =
    result?.message ||
    i18n.translate('data.pplLint.fixTool.failedMessage', {
      defaultMessage: 'The proposed PPL lint fix could not be applied.',
    });

  return (
    <EuiPanel paddingSize="s" data-test-subj="pplLintFixToolCall">
      <EuiText size="s">
        <strong>
          {i18n.translate('data.pplLint.fixTool.title', {
            defaultMessage: 'PPL lint fix',
          })}
        </strong>
      </EuiText>

      {session?.request.diagnostic.message && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="subdued">
            {session.request.diagnostic.message}
          </EuiText>
        </>
      )}

      {args?.explanation && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="s">{args.explanation}</EuiText>
        </>
      )}

      {args?.fixedQuery && (
        <>
          <EuiSpacer size="s" />
          <EuiCodeBlock
            language="ppl"
            fontSize="s"
            paddingSize="s"
            data-test-subj="pplLintFixToolFixedQuery"
          >
            {args.fixedQuery}
          </EuiCodeBlock>
        </>
      )}

      {showActions && (
        <>
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="s" responsive={false} justifyContent="flexEnd">
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="s" onClick={onReject} data-test-subj="pplLintFixDismissButton">
                {i18n.translate('data.pplLint.fixTool.dismissButton', {
                  defaultMessage: 'Dismiss',
                })}
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton size="s" fill onClick={onApprove} data-test-subj="pplLintFixApplyButton">
                {i18n.translate('data.pplLint.fixTool.applyButton', {
                  defaultMessage: 'Apply to editor',
                })}
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      )}

      {status === 'complete' && result?.success && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="success">
            {result.message}
          </EuiText>
        </>
      )}

      {status === 'failed' && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="danger">
            {failedMessage}
          </EuiText>
        </>
      )}
    </EuiPanel>
  );
};
