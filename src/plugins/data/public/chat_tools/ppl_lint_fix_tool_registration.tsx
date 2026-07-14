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
import {
  getPPLLintFixSession,
  getPPLLintFixOutcome,
  markPPLLintFixApplied,
  markPPLLintFixDismissed,
  markPPLLintFixFailed,
  subscribePPLLintFixOutcome,
  PPL_LINT_FIX_DATA_TOOL_NAME,
} from './ppl_lint_fix_session';
import { verifyPerformanceFixOutcome } from '../ppl_lint/verify_performance_fix_outcome';

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
  enabled?: boolean;
}

const noopUseAssistantAction: ContextProviderStart['hooks']['useAssistantAction'] = () => {};

const failure = (
  reason: NonNullable<PPLLintFixToolResult['reason']>,
  message: string,
  extra?: Pick<PPLLintFixToolResult, 'validationReason'>
): PPLLintFixToolResult => {
  // Flip the card to its terminal failure state immediately (rather than waiting
  // on the framework's tool-call status, which lags the AG-UI round-trip) while
  // still returning the machine-readable result the model needs.
  markPPLLintFixFailed(message);
  return {
    success: false,
    reason,
    message,
    ...extra,
  };
};

const PERFORMANCE_RULE_IDS = new Set(['operation-not-pushed', 'operation-pushed-as-script']);

export const PPLLintFixToolRegistration: React.FC<PPLLintFixToolRegistrationProps> = ({
  queryString,
  useAssistantAction,
  enabled = true,
}) => {
  const useAssistantActionHook = useAssistantAction || noopUseAssistantAction;

  useAssistantActionHook<PPLLintFixToolArgs>({
    name: PPL_LINT_FIX_DATA_TOOL_NAME,
    enabled,
    description:
      'Proposes a corrected OpenSearch PPL query for the active data editor lint-fix request. ' +
      'This tool does not execute the query; the UI asks the user to approve before the editor ' +
      'is updated. Call it directly with the corrected query — the active request is tracked by ' +
      'the UI, so no request id or hash is needed.',
    parameters: {
      type: 'object',
      properties: {
        fixedQuery: {
          type: 'string',
          description: 'The complete corrected OpenSearch PPL query.',
        },
        explanation: {
          type: 'string',
          description: 'One short plain-language sentence that says what changed and why it helps.',
        },
      },
      required: ['fixedQuery'],
    },
    requiresConfirmation: true,
    useCustomRenderer: true,
    handler: async (args) => {
      // Match against the single active session rather than a model-provided
      // requestId/sourceQueryHash: weaker models often fill those args with the
      // wrong values (rule name, query text), which used to trip a false
      // missing-request/hash-mismatch and — since the failure prompts a retry —
      // send the model into a tool-call loop. Staleness is enforced below by
      // comparing the live editor query to the one captured at request time.
      const session = getPPLLintFixSession();
      if (!session) {
        return failure(
          'missing-request',
          'The active PPL lint fix request is no longer available.'
        );
      }

      const currentQueryText = session.getCurrentQuery() ?? '';
      if (currentQueryText !== session.request.query) {
        return failure(
          'stale-query',
          'The editor changed after this PPL lint fix request was created.'
        );
      }

      if (typeof args.fixedQuery !== 'string' || !args.fixedQuery.trim()) {
        return failure('invalid-candidate', 'The proposed PPL query is missing.');
      }

      const fixedQuery = args.fixedQuery.trim();
      const lintContext = session.request.lintContext ?? session.getLintContext();
      const validation = validatePPLLintFixCandidate({
        originalQuery: session.request.query,
        fixedQuery,
        ruleId: session.request.diagnostic.ruleId,
        lintContext,
      });

      if (!validation.accepted) {
        return failure(
          'invalid-candidate',
          `The proposed query did not pass PPL lint validation: ${validation.reason || 'unknown'}.`,
          { validationReason: validation.reason }
        );
      }

      const performanceOutcomeCleared = await verifyPerformanceFixOutcome(
        session.request.query,
        fixedQuery,
        session.request.diagnostic,
        session.getLintContext(),
        () =>
          getPPLLintFixSession() === session &&
          (session.getCurrentQuery() ?? '') === session.request.query
      );
      if (
        getPPLLintFixSession() !== session ||
        (session.getCurrentQuery() ?? '') !== session.request.query
      ) {
        return failure(
          'stale-query',
          'The editor changed while this PPL lint fix was being validated.'
        );
      }
      if (!performanceOutcomeCleared) {
        return failure(
          'invalid-candidate',
          'The proposed query did not clear the attributed performance outcome.'
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
      markPPLLintFixApplied();

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
  // Re-render on outcome changes so the (otherwise idle) card reaches its
  // terminal state the instant the user acts, rather than waiting on the
  // framework's tool-call status — that only flips after the chat plugin
  // finishes the model's follow-up AG-UI turn, which is slow (60–128s observed)
  // and can hang, which used to leave both buttons looking dead.
  const [, forceRender] = React.useState(0);
  React.useEffect(() => subscribePPLLintFixOutcome(() => forceRender((n) => n + 1)), []);

  // Read the active session directly (not keyed on the streamed/model-provided
  // requestId) so the diagnostic info shows immediately and regardless of what
  // the model put in the args.
  const session = getPPLLintFixSession();

  // Prefer the local outcome (set synchronously by the click / apply handler)
  // over the framework status, which lags the AG-UI round-trip.
  const outcome = getPPLLintFixOutcome();
  const applied = outcome?.kind === 'applied' || (status === 'complete' && !!result?.success);
  const dismissed = outcome?.kind === 'dismissed';
  const failed = outcome?.kind === 'failed' || (!outcome && status === 'failed');
  const terminal = applied || dismissed || failed;
  const showActions = !terminal && (status === 'pending' || status === 'executing') && !!args;
  const diagnostic = session?.request.diagnostic;
  const explanation =
    (diagnostic?.ruleId && PERFORMANCE_RULE_IDS.has(diagnostic.ruleId)
      ? diagnostic.message
      : args?.explanation) || diagnostic?.message;
  const appliedMessage =
    result?.message ||
    i18n.translate('data.pplLint.fixTool.appliedMessage', {
      defaultMessage: 'Applied the PPL lint fix to the editor.',
    });
  const failedMessage =
    (outcome?.kind === 'failed' ? outcome.message : undefined) ||
    result?.message ||
    i18n.translate('data.pplLint.fixTool.failedMessage', {
      defaultMessage: 'The proposed PPL lint fix could not be applied.',
    });

  // Reject runs no handler (the tool is rejected before execution), so mark the
  // dismissal locally, then delegate so the confirmation promise still resolves.
  // Approve needs no local marking — the apply handler records the outcome.
  const handleReject = () => {
    markPPLLintFixDismissed();
    onReject?.();
  };

  return (
    <EuiPanel paddingSize="s" data-test-subj="pplLintFixToolCall">
      <EuiText size="s">
        <strong>
          {i18n.translate('data.pplLint.fixTool.title', {
            defaultMessage: 'Apply suggested fix',
          })}
        </strong>
      </EuiText>

      {explanation && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="s">{explanation}</EuiText>
        </>
      )}

      {args?.fixedQuery && (
        <>
          <EuiSpacer size="s" />
          <EuiCodeBlock
            language="sql"
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
              <EuiButtonEmpty
                size="s"
                onClick={handleReject}
                data-test-subj="pplLintFixDismissButton"
              >
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

      {applied && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="success">
            {appliedMessage}
          </EuiText>
        </>
      )}

      {dismissed && (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="subdued">
            {i18n.translate('data.pplLint.fixTool.dismissedMessage', {
              defaultMessage: 'Fix dismissed.',
            })}
          </EuiText>
        </>
      )}

      {failed && (
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
