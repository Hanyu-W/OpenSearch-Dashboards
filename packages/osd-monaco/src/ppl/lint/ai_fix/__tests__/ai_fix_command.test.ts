/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock the monaco barrel this module imports at load time (registerCommand etc.)
// so the handler can be unit-tested without the real editor.
jest.mock('../../../../monaco', () => ({
  monaco: {
    editor: {
      getModels: () => [],
      registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
    },
  },
}));

import { handleAiFixCommand, AiFixCommandArgs } from '../ai_fix_command';
import { AiFixHttpClient } from '../run_ai_fix';
import { CandidateLintFacts } from '../validate_candidate_fix';

const ORIGINAL = 'source=accounts | where age = "thirty"';
const FIXED = 'source=accounts | where age = 30';

const lintStub = (q: string): CandidateLintFacts =>
  q.trim() === ORIGINAL
    ? { ruleIds: ['type-mismatch-numeric'], syntaxClean: true }
    : { ruleIds: [], syntaxClean: true };
const shapeStub = (q: string): string[] =>
  q.trim() === ORIGINAL || q.trim() === FIXED ? ['searchCommand', 'whereCommand'] : ['x'];

const args: AiFixCommandArgs = {
  modelUri: 'inmemory://m.ppl',
  ruleId: 'type-mismatch-numeric',
  message: 'mismatch',
};

function http(over: Partial<AiFixHttpClient> = {}): AiFixHttpClient {
  return {
    get: jest.fn(async () => ({ configuredLanguages: ['PPL'] })),
    post: jest.fn(async () => ({ query: FIXED })),
    ...over,
  };
}

describe('handleAiFixCommand', () => {
  it('applies the validated fix via the apply callback', async () => {
    const apply = jest.fn();
    const outcome = await handleAiFixCommand(
      args,
      http(),
      { datasetTitle: 'accounts', dataSourceId: 'mds-1', enableAIFeatures: true },
      apply,
      ORIGINAL,
      { lint: lintStub, pipelineShape: shapeStub }
    );
    expect(outcome.status).toBe('applied');
    expect(apply).toHaveBeenCalledWith(FIXED);
  });

  it('does not apply when the candidate is rejected', async () => {
    const apply = jest.fn();
    const outcome = await handleAiFixCommand(
      args,
      http({ post: jest.fn(async () => ({ query: ORIGINAL })) }), // still trips the rule
      { datasetTitle: 'accounts', enableAIFeatures: true },
      apply,
      ORIGINAL,
      { lint: lintStub, pipelineShape: shapeStub }
    );
    expect(outcome.status).toBe('rejected');
    expect(apply).not.toHaveBeenCalled();
  });

  it('errors (does not apply) when there is no http client', async () => {
    const apply = jest.fn();
    const outcome = await handleAiFixCommand(
      args,
      undefined,
      { datasetTitle: 'accounts', enableAIFeatures: true },
      apply,
      ORIGINAL,
      { lint: lintStub, pipelineShape: shapeStub }
    );
    expect(outcome.status).toBe('error');
    expect(apply).not.toHaveBeenCalled();
  });

  it('skips (does not apply) when AI features are off', async () => {
    const apply = jest.fn();
    const outcome = await handleAiFixCommand(
      args,
      http(),
      { datasetTitle: 'accounts', enableAIFeatures: false },
      apply,
      ORIGINAL,
      { lint: lintStub, pipelineShape: shapeStub }
    );
    expect(outcome.status).toBe('skipped');
    expect(apply).not.toHaveBeenCalled();
  });
});
