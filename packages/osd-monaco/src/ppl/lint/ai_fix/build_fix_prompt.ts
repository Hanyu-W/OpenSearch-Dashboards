/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared length-capping helpers for the chat-based PPL lint-fix flow. The
 * user-visible chat message and out-of-band model context both use these
 * helpers to bound query and diagnostic source text.
 */

/** Hard cap on the query characters included in an AI chat fix request. */
export const MAX_QUERY_CHARS = 4096;

/** Truncate to the requested cap, marking the cut so the model knows it is partial. */
export function capLength(text: string, max: number = MAX_QUERY_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}… [truncated]`;
}
