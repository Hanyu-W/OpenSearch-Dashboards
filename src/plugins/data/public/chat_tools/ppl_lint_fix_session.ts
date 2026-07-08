/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AskPPLLintFixRequest, PPLLintContext } from '@osd/monaco';
import type { Query } from '../../common';

export const PPL_LINT_FIX_DATA_TOOL_NAME = 'apply_ppl_lint_fix_data';

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

export function getPPLLintFixSession(requestId: string): PPLLintFixSession | undefined {
  if (activeSession?.request.requestId !== requestId) {
    return undefined;
  }
  return activeSession;
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
