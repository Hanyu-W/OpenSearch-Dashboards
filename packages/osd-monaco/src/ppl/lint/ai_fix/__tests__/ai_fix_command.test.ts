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
import { hashPPLLintFixSource } from '../build_chat_fix_message';
import { compiledLintFacts } from '../validate_candidate_fix';
import { LintRunContext } from '../../types';
import {
  PPLLintTelemetryEvent,
  PPL_LINT_TELEMETRY_EVENTS,
  registerPPLLintTelemetry,
} from '../../telemetry';

const ORIGINAL = 'source=accounts | where age = "thirty"';

const args: AiFixCommandArgs = {
  modelUri: 'inmemory://m.ppl',
  ruleId: 'type-mismatch-numeric',
  message: 'mismatch',
};

describe('handleAiFixCommand', () => {
  let events: PPLLintTelemetryEvent[];
  beforeEach(() => {
    events = [];
    registerPPLLintTelemetry((event) => events.push(event));
  });
  afterEach(() => registerPPLLintTelemetry(undefined));

  it('dispatches an AI chat request without applying or generating a fix', () => {
    const onAskAiFix = jest.fn();
    const lintContext: LintRunContext = {
      fields: new Set(['age']),
      typeMap: new Map([['age', 'long']]),
    };

    const request = handleAiFixCommand(
      args,
      {
        datasetTitle: 'accounts',
        dataSourceId: 'mds-1',
        enableAIFeatures: true,
        onAskAiFix,
        aiFixToolName: 'apply_ppl_lint_fix_data',
      },
      ORIGINAL,
      lintContext,
      { createRequestId: () => 'req-1' }
    );

    expect(request).toEqual(
      expect.objectContaining({
        requestId: 'req-1',
        sourceQueryHash: hashPPLLintFixSource(ORIGINAL),
        toolName: 'apply_ppl_lint_fix_data',
        modelUri: args.modelUri,
        query: ORIGINAL,
        diagnostic: { message: 'mismatch', ruleId: 'type-mismatch-numeric' },
        datasetTitle: 'accounts',
        dataSourceId: 'mds-1',
        lintContext,
      })
    );
    expect(request?.chatMessage).not.toContain('apply_ppl_lint_fix_data');
    expect(request?.chatMessage).not.toContain('req-1');
    expect(request?.chatContext).toContain('apply_ppl_lint_fix_data');
    expect(onAskAiFix).toHaveBeenCalledWith(request);
    // Feature-usage telemetry: emitted once, after the chat request is sent,
    // carrying the rule id.
    expect(events).toEqual([
      {
        name: PPL_LINT_TELEMETRY_EVENTS.AI_FIX_CLICKED,
        data: { rule: 'type-mismatch-numeric' },
      },
    ]);
  });

  it('emits ai_fix_clicked with an undefined rule when the marker had no rule id', () => {
    const onAskAiFix = jest.fn();
    handleAiFixCommand(
      { modelUri: 'inmemory://m.ppl', message: 'msg' },
      { enableAIFeatures: true, onAskAiFix },
      ORIGINAL,
      undefined,
      { createRequestId: () => 'req-1' }
    );
    expect(events).toEqual([
      { name: PPL_LINT_TELEMETRY_EVENTS.AI_FIX_CLICKED, data: { rule: undefined } },
    ]);
  });

  it('does nothing when AI features are off', () => {
    const onAskAiFix = jest.fn();
    expect(
      handleAiFixCommand(args, { enableAIFeatures: false, onAskAiFix }, ORIGINAL, undefined, {
        createRequestId: () => 'req-1',
      })
    ).toBeUndefined();
    expect(onAskAiFix).not.toHaveBeenCalled();
    // No dispatch → no telemetry.
    expect(events).toHaveLength(0);
  });

  it('does nothing when the host did not wire a chat opener', () => {
    expect(
      handleAiFixCommand(
        args,
        { datasetTitle: 'accounts', enableAIFeatures: true },
        ORIGINAL,
        undefined,
        { createRequestId: () => 'req-1' }
      )
    ).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  // The apply tool reuses the exported validator. This regression guard keeps
  // the context-aware rule behavior the old silent path depended on.
  it('compiledLintFacts only raises a contextual rule when a typeMap is present', () => {
    const ctx: LintRunContext = {
      fields: new Set(['age']),
      typeMap: new Map([['age', 'long']]),
    };
    expect(compiledLintFacts(ORIGINAL, ctx).ruleIds).toContain('type-mismatch-numeric');
    expect(compiledLintFacts(ORIGINAL).ruleIds).not.toContain('type-mismatch-numeric');
  });
});
