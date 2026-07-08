/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildChatFixMessage,
  hashPPLLintFixSource,
  BuildChatFixMessageInput,
} from '../build_chat_fix_message';
import { MAX_QUERY_CHARS } from '../build_fix_prompt';

describe('buildChatFixMessage', () => {
  const request: BuildChatFixMessageInput = {
    requestId: 'req-1',
    sourceQueryHash: 'abcd1234',
    toolName: 'apply_ppl_lint_fix_data',
    modelUri: 'inmemory://m.ppl',
    query: 'source=accounts | where age = "thirty"',
    diagnostic: {
      message: 'Comparing numeric field to a string.',
      ruleId: 'type-mismatch-numeric',
    },
    datasetTitle: 'accounts',
    dataSourceId: 'mds-1',
  };

  it('frames the chat request with ids, diagnostic, source query, and apply tool instruction', () => {
    const message = buildChatFixMessage(request);
    expect(message).toContain('Request id: req-1');
    expect(message).toContain('Source query hash: abcd1234');
    expect(message).toContain('Dataset: accounts');
    expect(message).toContain('Data source id: mds-1');
    expect(message).toContain('Diagnostic: type-mismatch-numeric - Comparing numeric field');
    expect(message).toContain('```ppl');
    expect(message).toContain(request.query);
    expect(message).toContain('apply_ppl_lint_fix_data');
    expect(message).not.toContain('execute_ppl_query');
  });

  it('caps long queries before embedding them in the chat prompt', () => {
    const message = buildChatFixMessage({
      ...request,
      query: 'a'.repeat(MAX_QUERY_CHARS + 20),
    });
    expect(message).toContain('[truncated]');
    expect(message).not.toContain('a'.repeat(MAX_QUERY_CHARS + 1));
  });
});

describe('hashPPLLintFixSource', () => {
  it('is stable and changes when the source query changes', () => {
    expect(hashPPLLintFixSource('source=accounts')).toBe(hashPPLLintFixSource('source=accounts'));
    expect(hashPPLLintFixSource('source=accounts')).not.toBe(hashPPLLintFixSource('source=orders'));
  });
});
