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
import React from 'react';
import {
  cleanupPPLLintFixRequest,
  getPPLLintFixOutcome,
  getPPLLintFixSession,
  markPPLLintFixDismissed,
  subscribePPLLintFixOutcome,
} from './ppl_lint_fix_session';
import type { RemovePPLLintFixContextById } from './ppl_lint_fix_session';
import { PERFORMANCE_RULE_IDS } from './ppl_lint_fix_host';
import type { PPLLintFixHost } from './ppl_lint_fix_host';

/** Symbol used to bind the confirmed args clone back to the request the card captured. */
export const PPL_LINT_FIX_UI_BINDING = Symbol('pplLintFixUiBinding');

export interface PPLLintFixToolArgs {
  requestId?: string;
  sourceQueryHash?: string;
  fixedQuery: string;
  explanation?: string;
  confirmed?: boolean;
}

export type BoundPPLLintFixToolArgs = PPLLintFixToolArgs & {
  [PPL_LINT_FIX_UI_BINDING]?: string;
};

/**
 * Subset of the assistant framework's render props the card needs. Declared here
 * rather than imported so both hosts can pass their own framework's props without
 * the data plugin depending on either registration mechanism.
 */
export interface PPLLintFixCardProps {
  status: 'pending' | 'executing' | 'complete' | 'failed';
  args?: PPLLintFixToolArgs;
  result?: { success?: boolean; message?: string };
  error?: Error;
  onApprove?: () => void;
  onReject?: () => void;
  host: PPLLintFixHost;
  removeContextById?: RemovePPLLintFixContextById;
  /** Prefix for this surface's `data-test-subj` values, so host selectors stay stable. */
  testSubjPrefix: string;
}

/**
 * The one Apply/Dismiss card for the AI lint-fix flow, shared by every host.
 *
 * Rendered as a component (not a bare function call) so it can use hooks: it
 * subscribes to the local outcome signal so the otherwise-idle card re-renders and
 * reaches its terminal state the instant the user clicks, rather than waiting on
 * the framework's tool-call status. That status only flips after the chat plugin
 * finishes the model's follow-up AG-UI turn, which is slow (60–128s observed) and
 * can hang — gating the card on it made both buttons look dead even though the
 * click was handled.
 */
export const PPLLintFixCard: React.FC<PPLLintFixCardProps> = ({
  status,
  args,
  result,
  error,
  onApprove,
  onReject,
  host,
  removeContextById,
  testSubjPrefix,
}) => {
  const [, forceRender] = React.useState(0);
  const [submitted, setSubmitted] = React.useState(false);
  const submittedRef = React.useRef(false);
  React.useEffect(() => subscribePPLLintFixOutcome(() => forceRender((n) => n + 1)), []);

  // Capture the active request once for this card. The model-provided requestId
  // remains untrusted, but subsequent renders and clicks stay bound to the request
  // that produced this card even if a newer editor request replaces it.
  const candidateSession = getPPLLintFixSession();
  const activeSession =
    candidateSession?.getCurrentChatThreadId &&
    (!candidateSession.chatThreadId ||
      candidateSession.getCurrentChatThreadId() !== candidateSession.chatThreadId)
      ? undefined
      : candidateSession;
  const requestIdRef = React.useRef<string | undefined>(activeSession?.request.requestId);
  const requestId = requestIdRef.current;
  const session = requestId ? getPPLLintFixSession(requestId) : undefined;
  const diagnosticRef = React.useRef(session?.request.diagnostic);
  const diagnostic = session?.request.diagnostic ?? diagnosticRef.current;
  React.useEffect(
    () => () => {
      if (requestId) {
        cleanupPPLLintFixRequest(requestId, host.contextIdPrefix, removeContextById);
      }
    },
    [host.contextIdPrefix, removeContextById, requestId]
  );

  // Prefer the local outcome (set synchronously by the click / apply handler) over
  // the framework status, which lags the AG-UI round-trip.
  const outcome = requestId ? getPPLLintFixOutcome(requestId) : undefined;
  const applied = outcome?.kind === 'applied' || (status === 'complete' && !!result?.success);
  const dismissed = outcome?.kind === 'dismissed';
  const failed = outcome?.kind === 'failed' || (!outcome && status === 'failed');
  const failureMessage =
    (outcome?.kind === 'failed' ? outcome.message : undefined) ?? result?.message ?? error?.message;
  const terminal = applied || dismissed || failed;
  const showActions =
    !submitted &&
    !terminal &&
    (status === 'pending' || status === 'executing') &&
    !!args &&
    !!requestId &&
    !!session;

  // The performance rules carry their explanation on the diagnostic itself (it
  // names the attributed operation), so prefer it over the model's prose.
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
    failureMessage ||
    i18n.translate('data.pplLint.fixTool.failedMessage', {
      defaultMessage: 'The proposed PPL lint fix could not be applied.',
    });

  // Reject runs no handler (the tool is rejected before execution), so mark and
  // clean up this exact request before resolving the confirmation. Approval
  // carries the card-captured id into the handler without trusting model output.
  const handleApprove = () => {
    if (submittedRef.current) {
      return;
    }
    submittedRef.current = true;
    setSubmitted(true);
    if (requestId && args) {
      (args as BoundPPLLintFixToolArgs)[PPL_LINT_FIX_UI_BINDING] = requestId;
    }
    onApprove?.();
  };

  const handleReject = () => {
    if (submittedRef.current) {
      return;
    }
    submittedRef.current = true;
    setSubmitted(true);
    if (requestId) {
      markPPLLintFixDismissed(requestId);
      cleanupPPLLintFixRequest(requestId, host.contextIdPrefix, removeContextById);
    }
    onReject?.();
  };

  return (
    <EuiPanel paddingSize="s" data-test-subj={`${testSubjPrefix}ToolCall`}>
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
            data-test-subj={`${testSubjPrefix}FixedQuery`}
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
                data-test-subj={`${testSubjPrefix}DismissButton`}
              >
                {i18n.translate('data.pplLint.fixTool.dismissButton', {
                  defaultMessage: 'Dismiss',
                })}
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                fill
                onClick={handleApprove}
                data-test-subj={`${testSubjPrefix}ApplyButton`}
              >
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
