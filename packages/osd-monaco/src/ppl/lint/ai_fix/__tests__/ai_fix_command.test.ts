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

import {
  handleAiFixCommand,
  compiledLintFacts,
  summarizeOutcome,
  AiFixCommandArgs,
} from '../ai_fix_command';
import { AiFixHttpClient } from '../run_ai_fix';
import { CandidateLintFacts } from '../validate_candidate_fix';
import { LintRunContext } from '../../types';

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

  // Issue 2: with NO injected deps.lint, the default compiledLintFacts runs the
  // real analyzer bound to the model's lint context. type-mismatch-numeric is
  // needsContext:true and self-suppresses without a typeMap, so re-validation is
  // only meaningful when the context is threaded in.
  describe('real re-validation via threaded lint context', () => {
    const ctx: LintRunContext = {
      fields: new Set(['age']),
      typeMap: new Map([['age', 'long']]),
    };

    it('rejects a candidate that still trips the contextual rule (diagnostic-not-cleared)', async () => {
      const apply = jest.fn();
      const outcome = await handleAiFixCommand(
        args,
        // The agent "fixes" it to another non-numeric string → still trips
        // type-mismatch-numeric once the rule re-fires with the typeMap.
        http({
          post: jest.fn(async () => ({ query: 'source=accounts | where age = "still-bad"' })),
        }),
        { datasetTitle: 'accounts', dataSourceId: 'mds-1', enableAIFeatures: true },
        apply,
        ORIGINAL,
        undefined, // no deps → real compiledLintFacts / compiledPipelineShape
        ctx
      );
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.validation.reason).toBe('diagnostic-not-cleared');
      }
      expect(apply).not.toHaveBeenCalled();
    });

    it('compiledLintFacts only raises the contextual rule when a typeMap is present', () => {
      const bad = 'source=accounts | where age = "thirty"';
      expect(compiledLintFacts(bad, ctx).ruleIds).toContain('type-mismatch-numeric');
      // Without context the rule self-suppresses (the inert-revalidation bug).
      expect(compiledLintFacts(bad).ruleIds).not.toContain('type-mismatch-numeric');
    });
  });

  // Issue 9: the outcome is no longer discarded — it is summarized for the host
  // notification sink. summarizeOutcome is the pure mapping.
  describe('summarizeOutcome', () => {
    it('maps applied to a bare applied summary', () => {
      expect(summarizeOutcome({ status: 'applied', fixedQuery: FIXED })).toEqual({
        status: 'applied',
      });
    });

    it('carries the skip reason', () => {
      expect(summarizeOutcome({ status: 'skipped', reason: 'no-agent' })).toEqual({
        status: 'skipped',
        reason: 'no-agent',
      });
    });

    it('carries the rejection reason from the validation result', () => {
      expect(
        summarizeOutcome({
          status: 'rejected',
          validation: { accepted: false, reason: 'low-overlap' },
        })
      ).toEqual({ status: 'rejected', reason: 'low-overlap' });
    });

    it('carries the error message', () => {
      expect(summarizeOutcome({ status: 'error', message: 'boom' })).toEqual({
        status: 'error',
        message: 'boom',
      });
    });
  });
});
