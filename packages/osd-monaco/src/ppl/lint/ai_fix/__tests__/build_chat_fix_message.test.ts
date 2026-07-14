/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildChatFixContext,
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

  it('keeps machine plumbing out of the visible message', () => {
    const message = buildChatFixMessage(request);
    expect(message).toContain('Please fix this query.');
    expect(message).toContain('Comparing numeric field');
    expect(message).toContain('```ppl');
    expect(message).toContain(request.query);
    expect(message).not.toContain('type-mismatch-numeric');
    expect(message).not.toContain('req-1');
    expect(message).not.toContain('abcd1234');
    expect(message).not.toContain('apply_ppl_lint_fix_data');
    expect(message).not.toContain('execute_ppl_query');
  });

  it('puts tool instructions and precise target context out of band', () => {
    const context = buildChatFixContext({
      ...request,
      diagnostic: {
        ...request.diagnostic,
        targetText: 'age = "thirty"',
        relatedTexts: ['eval age = raw_age'],
      },
    });
    const message = buildChatFixMessage({
      ...request,
      diagnostic: {
        ...request.diagnostic,
        targetText: 'age = "thirty"',
        relatedTexts: ['eval age = raw_age'],
      },
    });
    expect(message).toContain('Part to fix: `age = "thirty"`');
    expect(message).not.toContain('Attributed target');
    expect(context).toContain('apply_ppl_lint_fix_data');
    expect(context).toContain('age = "thirty"');
    expect(context).toContain('eval age = raw_age');
    expect(context).toContain('localized change');
    expect(context).toContain('one short sentence in plain language');
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
