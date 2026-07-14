/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AskPPLLintFixRequest } from '../../lint_bridge';
import { capLength } from './build_fix_prompt';

export type BuildChatFixMessageInput = Omit<AskPPLLintFixRequest, 'chatMessage' | 'lintContext'>;

export const DEFAULT_PPL_LINT_FIX_TOOL_NAME = 'apply_ppl_lint_fix';

/** Stable, non-cryptographic hash used only to correlate a fix with its source text. */
export function hashPPLLintFixSource(query: string): string {
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = (hash * 31 + query.charCodeAt(i)) % 4294967291;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * The SHORT, human-facing chat bubble the user sees when they click "Ask Olly to
 * fix". It carries only a plain-language explanation, the part to fix, and the
 * query. Technical instructions for the model ride out-of-band via
 * {@link buildChatFixContext} so they never clutter the chat.
 */
export function buildChatFixMessage(request: BuildChatFixMessageInput): string {
  const query = capLength(request.query);
  const target = request.diagnostic.targetText;

  return [
    'Please fix this query.',
    '',
    request.diagnostic.message,
    ...(target ? ['', `Part to fix: \`${capLength(target, 512)}\``] : []),
    '',
    '```ppl',
    query,
    '```',
  ].join('\n');
}

/**
 * The out-of-band instructions for the model: how to correct the query and how to
 * hand the result back. Pushed into the assistant context store (AG-UI `context`
 * array) so the model receives it while the chat UI renders nothing for it. No
 * correlation ids are included — the UI tracks the single active fix request, so
 * the tool takes only the corrected query (no id/hash to echo, which weaker models
 * filled incorrectly and sent into a tool-call loop).
 */
export function buildChatFixContext(request: BuildChatFixMessageInput): string {
  const ruleId = request.diagnostic.ruleId || 'ppl-lint';
  const target = request.diagnostic.targetText;
  const related = request.diagnostic.relatedTexts?.filter(Boolean) ?? [];

  return [
    'You are correcting a PPL query for the OpenSearch Explore lint quick-fix flow.',
    `Diagnostic: ${ruleId} - ${request.diagnostic.message}`,
    '',
    ...(target
      ? [
          `The finding is precisely attributed to this source slice: ${capLength(target, 512)}`,
          ...(related.length
            ? [
                `Related definition/use slice(s): ${related
                  .map((text) => capLength(text, 256))
                  .join(', ')}`,
              ]
            : []),
          'Make a localized change to that attributed expression. Do not regenerate unrelated pipeline text.',
        ]
      : [
          'Make the smallest correction that clears the diagnostic while preserving the pipeline commands, fields, filters, and user intent.',
        ]),
    'Do not execute the query.',
    'Keep the explanation to one short sentence in plain language. Say what changed and why it helps. Do not mention rule IDs, attribution, Painless scripts, pushdown, indexes, data nodes, coordinators, or per-document evaluation.',
    `When you have the correction, call the ${request.toolName} tool with just the fixedQuery (and optionally a short explanation). Do not ask the user for a request id or hash — the UI already tracks the active request.`,
  ].join('\n');
}
