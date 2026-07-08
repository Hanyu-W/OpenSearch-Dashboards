/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AskPPLLintFixRequest, PPLLintContext } from '@osd/monaco';

export const APPLY_PPL_LINT_FIX_EXPLORE_TOOL_NAME = 'apply_ppl_lint_fix_explore';

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
