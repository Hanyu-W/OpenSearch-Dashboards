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

// The last query text successfully applied to the editor, plus subscribers to
// notify. The card render uses this to show "Query updated" immediately on apply,
// without waiting for the model's follow-up turn (which flips the framework's
// tool-call status but can lag or hang on the AG-UI round-trip). A pub/sub is
// used so the (otherwise idle) card re-renders when the fix is applied. Keyed by
// the fixedQuery string since the model does not reliably echo the requestId.
let lastAppliedFixedQuery: string | undefined;
const appliedSubscribers = new Set<() => void>();

function notifyAppliedSubscribers() {
  appliedSubscribers.forEach((cb) => cb());
}

export function setActivePPLLintFixSession(session: PPLLintFixSession) {
  activeSession = session;
  // A fresh request starts un-applied so its card shows the Apply/Dismiss buttons
  // rather than inheriting a previous fix's success state.
  lastAppliedFixedQuery = undefined;
  notifyAppliedSubscribers();
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
  lastAppliedFixedQuery = fixedQuery.trim();
  notifyAppliedSubscribers();
}

/** True when the given fixed query was the one just applied to the editor. */
export function isPPLLintFixApplied(fixedQuery?: string) {
  return !!fixedQuery && lastAppliedFixedQuery === fixedQuery.trim();
}

/** Subscribe to apply-state changes so an idle fix card can re-render on apply. */
export function subscribePPLLintFixApplied(callback: () => void): () => void {
  appliedSubscribers.add(callback);
  return () => appliedSubscribers.delete(callback);
}
