/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import { pplLintCodeActionProvider } from '../code_action_provider';
import { LINT_MARKER_SOURCE, SYNTAX_MARKER_SOURCE } from '../diagnostic_to_marker';
import { setModelFixes, clearModelFixes, markerFixKey, MarkerFix } from '../fix_registry';
import { setPPLLintContext, clearPPLLintContext } from '../../lint_bridge';
import { AI_FIX_COMMAND_ID } from '../ai_fix/ai_fix_command_id';

type LintMarker = monaco.editor.IMarkerData;

const model = ({
  uri: monaco.Uri.parse('inmemory://model/ai.ppl'),
  getVersionId: () => 1,
} as unknown) as monaco.editor.ITextModel;

// A marker carrying an AI-fixable ruleId on `code` (the object form with a link),
// mirroring diagnosticToMarker's output.
function aiMarker(ruleId: string, overrides: Partial<LintMarker> = {}): LintMarker {
  return {
    severity: monaco.MarkerSeverity.Warning,
    message: 'msg',
    startLineNumber: 1,
    startColumn: 5,
    endLineNumber: 1,
    endColumn: 10,
    source: LINT_MARKER_SOURCE,
    code: { value: ruleId, target: monaco.Uri.parse('https://docs') },
    ...overrides,
  } as LintMarker;
}

function provide(markers: LintMarker[]) {
  const result = pplLintCodeActionProvider.provideCodeActions(
    model,
    {} as monaco.Range,
    { markers, only: undefined, trigger: 1 } as monaco.languages.CodeActionContext,
    ({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown) as monaco.CancellationToken
  ) as monaco.languages.CodeActionList;
  return result.actions;
}

describe('pplLintCodeActionProvider — AI quick-fix emission', () => {
  afterEach(() => {
    clearModelFixes(model);
    clearPPLLintContext(model);
  });

  it('emits an isAI command action for an AI-fixable rule when AI + index are present', () => {
    setPPLLintContext(model, { enableAIFeatures: true, datasetTitle: 'accounts' } as any);
    const actions = provide([aiMarker('type-mismatch-numeric')]);
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toContain('Ask Olly to fix');
    expect((actions[0] as any).isAI).toBe(true);
    expect(actions[0].command?.id).toBe(AI_FIX_COMMAND_ID);
    expect((actions[0].command?.arguments?.[0] as any).ruleId).toBe('type-mismatch-numeric');
    // It carries a command, not an edit.
    expect(actions[0].edit).toBeUndefined();
  });

  it('does not emit an AI action when AI features are disabled', () => {
    setPPLLintContext(model, { enableAIFeatures: false, datasetTitle: 'accounts' } as any);
    expect(provide([aiMarker('type-mismatch-numeric')])).toHaveLength(0);
  });

  it('does not emit an AI action when no index (datasetTitle) is known', () => {
    setPPLLintContext(model, { enableAIFeatures: true } as any);
    expect(provide([aiMarker('type-mismatch-numeric')])).toHaveLength(0);
  });

  it('does not emit an AI action for a non-AI-fixable rule', () => {
    setPPLLintContext(model, { enableAIFeatures: true, datasetTitle: 'accounts' } as any);
    // field-validation already ships a deterministic Levenshtein fix → no AI tier.
    expect(provide([aiMarker('field-validation')])).toHaveLength(0);
  });

  it('prefers the deterministic fix and does not also emit an AI action', () => {
    setPPLLintContext(model, { enableAIFeatures: true, datasetTitle: 'accounts' } as any);
    const marker = aiMarker('type-mismatch-numeric');
    const fixes = new Map<string, MarkerFix>();
    fixes.set(markerFixKey(marker), { title: 'Replace with 30', text: '30' });
    setModelFixes(model, fixes);
    const actions = provide([marker]);
    // Only the deterministic quick-fix; the AI tier is suppressed when a fix exists.
    expect(actions).toHaveLength(1);
    expect((actions[0] as any).isAI).toBeFalsy();
    expect(actions[0].title).toBe('Replace with 30');
  });

  it('never emits an AI action on the syntax channel', () => {
    setPPLLintContext(model, { enableAIFeatures: true, datasetTitle: 'accounts' } as any);
    const syntax = aiMarker('type-mismatch-numeric', { source: SYNTAX_MARKER_SOURCE });
    expect(provide([syntax])).toHaveLength(0);
  });
});
