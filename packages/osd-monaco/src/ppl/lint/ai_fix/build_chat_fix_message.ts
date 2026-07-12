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
 * fix". It carries only what reads well in the transcript — the rule and the
 * offending query. The machine plumbing the model needs to call the tool
 * (requestId, sourceQueryHash, toolName, and the how-to-respond instructions)
 * rides out-of-band via {@link buildChatFixContext} so it never clutters the chat.
 */
export function buildChatFixMessage(request: BuildChatFixMessageInput): string {
  const ruleId = request.diagnostic.ruleId || 'ppl-lint';
  const query = capLength(request.query);

  return [
    `Fix this OpenSearch PPL query — it has a \`${ruleId}\` lint issue: ${request.diagnostic.message}`,
    '',
    '```ppl',
    query,
    '```',
  ].join('\n');
}

/**
 * The out-of-band context for the fix request: the correlation ids and the
 * tool-calling instructions the model needs, but that the user should not have to
 * read. Pushed into the assistant context store (AG-UI `context` array) so the
 * model receives it while the chat UI renders nothing for it. Returns the
 * `value` string for a single context entry; the caller supplies id/label.
 */
export function buildChatFixContext(request: BuildChatFixMessageInput): string {
  const ruleId = request.diagnostic.ruleId || 'ppl-lint';
  const dataset = request.datasetTitle || 'unknown';
  const dataSource = request.dataSourceId || 'unknown';

  return [
    'You are correcting a PPL query for the OpenSearch Explore lint quick-fix flow.',
    `Request id: ${request.requestId}`,
    `Source query hash: ${request.sourceQueryHash}`,
    `Dataset: ${dataset}`,
    `Data source id: ${dataSource}`,
    `Diagnostic: ${ruleId} - ${request.diagnostic.message}`,
    '',
    'Make the smallest correction that clears the diagnostic while preserving the pipeline commands, fields, filters, and user intent.',
    'Do not execute the query.',
    `When you are ready for the user to review the correction, call the ${request.toolName} tool with requestId, sourceQueryHash, fixedQuery, and a short explanation. Use exactly the requestId and sourceQueryHash given above.`,
  ].join('\n');
}
