/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { runAiFix, RunAiFixDeps, AiFixHttpClient } from '../run_ai_fix';
import { CandidateLintFacts } from '../validate_candidate_fix';

const ORIGINAL = 'source=accounts | where age = "thirty"';
const FIXED = 'source=accounts | where age = 30';

// A lint stub: original raises the rule, the fixed query is clean; both share a
// shape. Anything else is clean with an empty shape.
function lintStub(query: string): CandidateLintFacts {
  if (query.trim() === ORIGINAL) return { ruleIds: ['type-mismatch-numeric'], syntaxClean: true };
  return { ruleIds: [], syntaxClean: true };
}
function shapeStub(query: string): string[] {
  if (query.trim() === ORIGINAL || query.trim() === FIXED) {
    return ['searchCommand', 'whereCommand'];
  }
  return ['other'];
}

function makeHttp(over: Partial<AiFixHttpClient> = {}): AiFixHttpClient {
  return {
    get: jest.fn(async () => ({ configuredLanguages: ['PPL'] })),
    post: jest.fn(async () => ({ query: FIXED })),
    ...over,
  };
}

function makeDeps(http: AiFixHttpClient): RunAiFixDeps {
  return {
    http,
    languagesPath: '/api/enhancements/assist/languages',
    generatePath: '/api/enhancements/assist/generate',
    lint: lintStub,
    pipelineShape: shapeStub,
  };
}

const baseRequest = {
  query: ORIGINAL,
  diagnostic: { message: 'mismatch', ruleId: 'type-mismatch-numeric' },
  datasetTitle: 'accounts',
  dataSourceId: 'mds-1',
  enableAIFeatures: true,
};

describe('runAiFix', () => {
  it('applies a valid generated fix end to end', async () => {
    const http = makeHttp();
    const outcome = await runAiFix(baseRequest, makeDeps(http));
    expect(outcome).toEqual({ status: 'applied', fixedQuery: FIXED });
    // The generate POST carries index + language + a fix-shaped question with the
    // query sent verbatim (Option B raw egress, gated on ENABLE_AI_FEATURES —
    // same posture as Query-Assist), so the agent can return an applicable fix.
    const postBody = JSON.parse((http.post as jest.Mock).mock.calls[0][1].body);
    expect(postBody.index).toBe('accounts');
    expect(postBody.language).toBe('PPL');
    expect(postBody.dataSourceId).toBe('mds-1');
    expect(postBody.question).toContain('Fix this PPL query');
    expect(postBody.question).toContain(ORIGINAL); // verbatim, not redacted
  });

  it('skips when AI features are disabled (no egress)', async () => {
    const http = makeHttp();
    const outcome = await runAiFix({ ...baseRequest, enableAIFeatures: false }, makeDeps(http));
    expect(outcome).toEqual({ status: 'skipped', reason: 'ai-disabled' });
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('skips when no index (datasetTitle) is known', async () => {
    const http = makeHttp();
    const outcome = await runAiFix({ ...baseRequest, datasetTitle: undefined }, makeDeps(http));
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-index' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('skips gracefully when no PPL agent is configured', async () => {
    const http = makeHttp({ get: jest.fn(async () => ({ configuredLanguages: ['PROMQL'] })) });
    const outcome = await runAiFix(baseRequest, makeDeps(http));
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-agent' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('skips when the languages probe throws (degrade, never crash)', async () => {
    const http = makeHttp({
      get: jest.fn(async () => {
        throw new Error('network');
      }),
    });
    const outcome = await runAiFix(baseRequest, makeDeps(http));
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-agent' });
  });

  it('errors when the generate route returns no query', async () => {
    const http = makeHttp({ post: jest.fn(async () => ({})) });
    const outcome = await runAiFix(baseRequest, makeDeps(http));
    expect(outcome.status).toBe('error');
  });

  it('errors when the generate route throws', async () => {
    const http = makeHttp({
      post: jest.fn(async () => {
        throw new Error('5xx');
      }),
    });
    const outcome = await runAiFix(baseRequest, makeDeps(http));
    expect(outcome).toEqual({ status: 'error', message: '5xx' });
  });

  it('rejects an unsafe candidate (intent not preserved) and does not apply', async () => {
    // Agent regenerates a completely different query: clean + same shape but
    // low token overlap → validator rejects it.
    const http = makeHttp({
      post: jest.fn(async () => ({ query: 'source=secrets | where x = 1' })),
    });
    const deps: RunAiFixDeps = {
      ...makeDeps(http),
      pipelineShape: () => ['searchCommand', 'whereCommand'], // coincidentally same shape
    };
    const outcome = await runAiFix(baseRequest, deps);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.validation.reason).toBe('low-overlap');
    }
  });

  it('rejects a candidate that still trips the original diagnostic', async () => {
    const http = makeHttp({ post: jest.fn(async () => ({ query: ORIGINAL })) });
    const outcome = await runAiFix(baseRequest, makeDeps(http));
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.validation.reason).toBe('diagnostic-not-cleared');
    }
  });
});
