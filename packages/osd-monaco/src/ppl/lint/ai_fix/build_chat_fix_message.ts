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

export function buildChatFixMessage(request: BuildChatFixMessageInput): string {
  const ruleId = request.diagnostic.ruleId || 'ppl-lint';
  const dataset = request.datasetTitle || 'unknown';
  const dataSource = request.dataSourceId || 'unknown';
  const query = capLength(request.query);

  return [
    'Please help fix this OpenSearch PPL query.',
    '',
    `Request id: ${request.requestId}`,
    `Source query hash: ${request.sourceQueryHash}`,
    `Dataset: ${dataset}`,
    `Data source id: ${dataSource}`,
    `Diagnostic: ${ruleId} - ${request.diagnostic.message}`,
    '',
    'Original PPL:',
    '```ppl',
    query,
    '```',
    '',
    'Make the smallest correction that clears the diagnostic while preserving the pipeline commands, fields, filters, and user intent.',
    'Do not execute the query.',
    `When you are ready for the user to review the correction, call the ${request.toolName} tool with requestId, sourceQueryHash, fixedQuery, and a short explanation.`,
  ].join('\n');
}
