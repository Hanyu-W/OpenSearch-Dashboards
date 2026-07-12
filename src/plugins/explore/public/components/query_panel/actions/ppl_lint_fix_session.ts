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

export function setActivePPLLintFixSession(session: PPLLintFixSession) {
  activeSession = session;
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
