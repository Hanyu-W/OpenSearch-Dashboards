/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AskPPLLintFixRequest, PPLLintContext } from '@osd/monaco';

export const APPLY_PPL_LINT_FIX_EXPLORE_TOOL_NAME = 'apply_ppl_lint_fix_explore';

/**
 * Prefix for the assistant-context-store entry that carries a fix request's
 * out-of-band metadata (correlation ids + tool instructions). Keyed by requestId
 * so the entry can be added when chat opens and removed once the fix is applied
 * or dismissed. Kept here so the editor (which adds it) and the apply action
 * (which removes it) agree on the id.
 */
export const PPL_LINT_FIX_CONTEXT_ID_PREFIX = 'ppl-lint-fix-';

export interface PPLLintFixSession {
  request: AskPPLLintFixRequest;
  getCurrentQuery: () => string | undefined;
  getLintContext: () => PPLLintContext;
}

let activeSession: PPLLintFixSession | undefined;

/**
 * Terminal outcome of the active fix, driven directly by the card's
 * Apply/Dismiss click and the apply handler — NOT by the framework's tool-call
 * status. The framework status only flips after `sendToolResultToAssistant`
 * completes, which waits on the model's follow-up AG-UI turn (observed at
 * 60–128s live, and it can hang). Gating the card on that made both buttons look
 * dead: the query updated (or the dismiss happened) but the card stayed frozen
 * with its buttons up. This local signal lets the card reach its terminal state
 * the instant the user acts.
 */
export type PPLLintFixOutcome =
  | { kind: 'applied'; fixedQuery: string }
  | { kind: 'failed'; message?: string }
  | { kind: 'dismissed' };

let lastFixOutcome: PPLLintFixOutcome | undefined;
const outcomeSubscribers = new Set<() => void>();

function notifyOutcomeSubscribers() {
  outcomeSubscribers.forEach((cb) => cb());
}

export function setActivePPLLintFixSession(session: PPLLintFixSession) {
  activeSession = session;
  // A fresh request starts with no outcome so its card shows the Apply/Dismiss
  // buttons rather than inheriting a previous fix's terminal state.
  lastFixOutcome = undefined;
  notifyOutcomeSubscribers();
}

export function getActivePPLLintFixSession(requestId?: string) {
  if (!requestId) {
    return activeSession;
  }

  return activeSession?.request.requestId === requestId ? activeSession : undefined;
}

export function clearActivePPLLintFixSession(requestId?: string) {
  if (!requestId || activeSession?.request.requestId === requestId) {
    activeSession = undefined;
  }
}

/** Record that a fixed query was applied to the editor, for immediate card feedback. */
export function markPPLLintFixApplied(fixedQuery: string) {
  lastFixOutcome = { kind: 'applied', fixedQuery: fixedQuery.trim() };
  notifyOutcomeSubscribers();
}

/** Record that the active fix could not be applied, for immediate card feedback. */
export function markPPLLintFixFailed(message?: string) {
  lastFixOutcome = { kind: 'failed', message };
  notifyOutcomeSubscribers();
}

/** Record that the user dismissed the active fix, for immediate card feedback. */
export function markPPLLintFixDismissed() {
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
