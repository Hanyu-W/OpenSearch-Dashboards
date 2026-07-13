/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AskPPLLintFixRequest, PPLLintContext } from '@osd/monaco';
import type { Query } from '../../common';

export const PPL_LINT_FIX_DATA_TOOL_NAME = 'apply_ppl_lint_fix_data';

/**
 * Prefix for the assistant-context-store entry carrying a fix request's
 * out-of-band metadata (correlation ids + tool instructions). Keyed by requestId
 * so it can be added when chat opens and removed once the fix is applied. Shared
 * between the query editor (adds it) and the tool registration (removes it).
 */
export const PPL_LINT_FIX_DATA_CONTEXT_ID_PREFIX = 'ppl-lint-fix-data-';

export type { AskPPLLintFixRequest } from '@osd/monaco';

export interface PPLLintFixSession {
  request: AskPPLLintFixRequest;
  getCurrentQuery: () => string | undefined;
  getCurrentQueryState: () => Query;
  getLintContext: () => PPLLintContext;
}

let activeSession: PPLLintFixSession | undefined;

/**
 * Terminal outcome of the active fix, driven directly by the card's
 * Apply/Dismiss click and the apply handler — NOT by the framework's tool-call
 * status. The framework status only flips after the chat plugin finishes sending
 * the tool result, which waits on the model's follow-up AG-UI turn (observed at
 * 60–128s live, and it can hang). Gating the card on that made both buttons look
 * dead: the query updated (or the dismiss happened) but the card stayed frozen
 * with its buttons up. This local signal lets the card reach its terminal state
 * the instant the user acts.
 */
export type PPLLintFixOutcome =
  | { kind: 'applied' }
  | { kind: 'failed'; message?: string }
  | { kind: 'dismissed' };

let lastFixOutcome: PPLLintFixOutcome | undefined;
const outcomeSubscribers = new Set<() => void>();

function notifyOutcomeSubscribers(): void {
  outcomeSubscribers.forEach((cb) => cb());
}

export function storePPLLintFixSession(session: PPLLintFixSession): void {
  activeSession = session;
  // A fresh request starts with no outcome so its card shows the Apply/Dismiss
  // buttons rather than inheriting a previous fix's terminal state.
  lastFixOutcome = undefined;
  notifyOutcomeSubscribers();
}

/** Record that the fix was applied to the editor, for immediate card feedback. */
export function markPPLLintFixApplied(): void {
  lastFixOutcome = { kind: 'applied' };
  notifyOutcomeSubscribers();
}

/** Record that the active fix could not be applied, for immediate card feedback. */
export function markPPLLintFixFailed(message?: string): void {
  lastFixOutcome = { kind: 'failed', message };
  notifyOutcomeSubscribers();
}

/** Record that the user dismissed the active fix, for immediate card feedback. */
export function markPPLLintFixDismissed(): void {
  lastFixOutcome = { kind: 'dismissed' };
  notifyOutcomeSubscribers();
}

/** The active fix's terminal outcome, or undefined while it is still pending. */
export function getPPLLintFixOutcome(): PPLLintFixOutcome | undefined {
  return lastFixOutcome;
}

/** Subscribe to outcome changes so an idle fix card can re-render when the user acts. */
export function subscribePPLLintFixOutcome(callback: () => void): () => void {
  outcomeSubscribers.add(callback);
  return () => outcomeSubscribers.delete(callback);
}

export function getPPLLintFixSession(requestId?: string): PPLLintFixSession | undefined {
  // With no requestId, return the single active session. Callers no longer key on
  // a model-provided requestId (weak models fill it with wrong values); the active
  // session is the source of truth and staleness is checked against its own query.
  if (!requestId) {
    return activeSession;
  }
  return activeSession?.request.requestId === requestId ? activeSession : undefined;
}

export function clearPPLLintFixSession(): void {
  activeSession = undefined;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => {
      clearTimeout(timeoutId);
    });
  });
}
