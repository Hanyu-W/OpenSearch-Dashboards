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

export function storePPLLintFixSession(session: PPLLintFixSession): void {
  activeSession = session;
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
