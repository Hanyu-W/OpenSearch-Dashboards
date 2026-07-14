/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
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
import { verifyPerformanceFixOutcome } from '../../../../../data/public';
import { useOpenSearchDashboards } from '../../../../../opensearch_dashboards_react/public';
import { ExploreServices } from '../../../types';
import { useSetEditorTextWithQuery } from '../../../application/hooks';
import {
  APPLY_PPL_LINT_FIX_EXPLORE_TOOL_NAME,
  PPL_LINT_FIX_CONTEXT_ID_PREFIX,
  clearActivePPLLintFixSession,
  getActivePPLLintFixSession,
  getPPLLintFixOutcome,
  markPPLLintFixApplied,
  markPPLLintFixDismissed,
  markPPLLintFixFailed,
  subscribePPLLintFixOutcome,
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

const PERFORMANCE_RULE_IDS = new Set(['operation-not-pushed', 'operation-pushed-as-script']);

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
    'Proposes a corrected OpenSearch PPL query for the active Explore lint-fix request. ' +
    'This tool does not execute the query; the UI asks the user to approve before the editor ' +
    'is updated. Call it directly with the corrected query — the active request is tracked by ' +
    'the UI, so no request id or hash is needed.',
  parameters: {
    type: 'object' as const,
    properties: {
      fixedQuery: {
        type: 'string',
        description: 'The proposed corrected OpenSearch PPL query.',
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

// Rendered as a component (not a bare function call) so it can use hooks: it
// subscribes to the local outcome signal so the otherwise-idle card re-renders
// and reaches its terminal state (applied / failed / dismissed) the instant the
// user clicks, rather than waiting on the framework's tool-call status. That
// status only flips after `sendToolResultToAssistant` completes the model's
// follow-up AG-UI turn, which is slow (60–128s observed) and can hang — gating
// the card on it made both buttons look dead even though the click was handled.
const PPLLintFixCard: React.FC<PPLLintFixRenderProps> = ({
  status,
  args,
  result,
  error,
  onApprove,
  onReject,
}) => {
  const [, forceRender] = useState(0);
  useEffect(() => subscribePPLLintFixOutcome(() => forceRender((n) => n + 1)), []);

  // There is only one active lint-fix session. Read it directly so partial or
  // inaccurate model-provided arguments cannot hide the diagnostic.
  const session = getActivePPLLintFixSession();
  const diagnosticRef = useRef(session?.request.diagnostic);
  const diagnostic = session?.request.diagnostic ?? diagnosticRef.current;

  // Prefer the local outcome (set synchronously by the click / apply handler)
  // over the framework status, which lags the AG-UI round-trip. The apply
  // handler resolves the confirmation promise, so by the time it returns the
  // outcome is already recorded; the framework 'complete'/'failed' flip is only
  // a fallback for a reload where the local signal was lost.
  const outcome = getPPLLintFixOutcome();
  const applied = outcome?.kind === 'applied' || status === 'complete';
  const dismissed = outcome?.kind === 'dismissed';
  const failed = outcome?.kind === 'failed' || (!outcome && status === 'failed');
  const failureMessage =
    (outcome?.kind === 'failed' ? outcome.message : undefined) ?? result?.message ?? error?.message;
  const terminal = applied || dismissed || failed;
  const explanation =
    (diagnostic?.ruleId && PERFORMANCE_RULE_IDS.has(diagnostic.ruleId)
      ? diagnostic.message
      : args?.explanation) || diagnostic?.message;

  // Approve needs no local marking — the apply handler records the applied/failed
  // outcome itself. Reject has no handler that runs (the tool is rejected before
  // execution), so the card marks the dismissal locally, then delegates so the
  // confirmation promise still resolves.
  const handleReject = () => {
    markPPLLintFixDismissed();
    onReject?.();
  };

  return (
    <div data-test-subj="pplLintFixExploreActionRenderer">
      <EuiText size="s">
        <strong>
          {i18n.translate('explore.pplLintFixAction.title', {
            defaultMessage: 'Apply suggested fix',
          })}
        </strong>
        {explanation ? <p>{explanation}</p> : null}
      </EuiText>

      {args?.fixedQuery ? (
        <>
          <EuiSpacer size="s" />
          <EuiCodeBlock language="sql" paddingSize="s" isCopyable={true}>
            {args.fixedQuery}
          </EuiCodeBlock>
        </>
      ) : null}

      {!terminal && (status === 'pending' || status === 'executing') ? (
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
                onClick={handleReject}
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

      {applied ? (
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

      {dismissed ? (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            size="s"
            color="primary"
            title={i18n.translate('explore.pplLintFixAction.dismissed', {
              defaultMessage: 'Fix dismissed.',
            })}
          />
        </>
      ) : null}

      {failed ? (
        <>
          <EuiSpacer size="s" />
          <EuiCallOut
            size="s"
            color="danger"
            title={
              failureMessage ??
              i18n.translate('explore.pplLintFixAction.failed', {
                defaultMessage: 'The proposed fix could not be applied.',
              })
            }
          />
        </>
      ) : null}
    </div>
  );
};

// The assistant-action framework calls the registered `render` as a plain
// function; return the card as an element so React mounts it as a component and
// its hooks (the apply-state subscription) work.
export function renderPPLLintFixAction(props: PPLLintFixRenderProps) {
  return <PPLLintFixCard {...props} />;
}

export function usePPLLintFixAction(
  setEditorTextWithQuery: ReturnType<typeof useSetEditorTextWithQuery>
) {
  const { services } = useOpenSearchDashboards<ExploreServices>();
  const registerAction = services.contextProvider?.actions?.registerAssistantAction;

  // Drop the out-of-band fix-context entry the editor pushed for this request so
  // it does not linger in the conversation after the fix is applied/dismissed.
  const removeFixContext = (requestId?: string) => {
    if (!requestId) return;
    const store = services.contextProvider?.getAssistantContextStore?.();
    store?.removeContextById?.(PPL_LINT_FIX_CONTEXT_ID_PREFIX + requestId);
  };

  useMount(() => {
    if (!registerAction) return;

    registerAction({
      ...APPLY_PPL_LINT_FIX_EXPLORE_TOOL_DEFINITION,
      handler: async (args: ApplyPPLLintFixArgs = {} as ApplyPPLLintFixArgs) => {
        // Flip the card to its terminal failure state immediately (rather than
        // waiting on the framework's tool-call status, which lags the AG-UI
        // round-trip) while still returning the machine-readable result the
        // model needs.
        const fail = (
          requestId: string | undefined,
          reason: string,
          message: string,
          extra?: Record<string, unknown>
        ) => {
          markPPLLintFixFailed(message);
          return buildFailureResult(requestId, reason, message, extra);
        };

        try {
          // Match against the single active session directly rather than trusting
          // model-provided requestId/sourceQueryHash. Weaker models frequently fill
          // those args with the wrong values (e.g. the rule name or the query text),
          // which used to trip a false stale-request/hash-mismatch and, because the
          // failure result prompts a retry, sent the model into a tool-call loop.
          // Staleness is instead enforced below by comparing the live editor query
          // to the query captured when the fix was requested — which needs no model
          // input and is the check that actually matters.
          const session = getActivePPLLintFixSession();
          if (!session) {
            return fail(
              undefined,
              'missing-request',
              'No active Explore PPL lint fix request was found.'
            );
          }

          const currentQuery = session.getCurrentQuery() ?? '';
          if (currentQuery !== session.request.query) {
            return fail(
              session.request.requestId,
              'stale-query',
              'The query changed after the fix request was opened. Ask for a fresh fix.'
            );
          }

          const fixedQuery = (args.fixedQuery ?? '').trim();
          if (!fixedQuery) {
            return fail(
              session.request.requestId,
              'invalid-candidate',
              'No corrected query was provided.'
            );
          }
          const validation = validatePPLLintFixCandidate({
            originalQuery: session.request.query,
            fixedQuery,
            ruleId: session.request.diagnostic.ruleId,
            lintContext: session.request.lintContext ?? session.getLintContext(),
          });

          if (!validation.accepted) {
            return fail(
              session.request.requestId,
              validation.reason ?? 'invalid-candidate',
              'The proposed fix did not pass PPL lint validation.',
              { validation }
            );
          }

          const performanceOutcomeCleared = await verifyPerformanceFixOutcome(
            session.request.query,
            fixedQuery,
            session.request.diagnostic,
            session.getLintContext(),
            () =>
              getActivePPLLintFixSession() === session &&
              (session.getCurrentQuery() ?? '') === session.request.query
          );
          if (
            getActivePPLLintFixSession() !== session ||
            (session.getCurrentQuery() ?? '') !== session.request.query
          ) {
            return fail(
              session.request.requestId,
              'stale-query',
              'The query changed while this PPL lint fix was being validated.'
            );
          }
          if (!performanceOutcomeCleared) {
            return fail(
              session.request.requestId,
              'invalid-candidate',
              'The proposed query did not clear the attributed performance outcome.'
            );
          }

          setEditorTextWithQuery(fixedQuery);
          markPPLLintFixApplied(fixedQuery);
          removeFixContext(session.request.requestId);
          clearActivePPLLintFixSession(session.request.requestId);

          return {
            success: true,
            applied: true,
            requestId: session.request.requestId,
            query: fixedQuery,
            message: 'Applied the PPL lint fix to the Explore query editor.',
          };
        } catch (handlerError) {
          return fail(
            getActivePPLLintFixSession()?.request.requestId,
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
    removeFixContext(getActivePPLLintFixSession()?.request.requestId);
    clearActivePPLLintFixSession();
  });
}
