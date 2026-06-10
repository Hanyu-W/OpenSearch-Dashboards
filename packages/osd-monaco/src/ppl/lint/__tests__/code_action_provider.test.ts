/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import { pplLintCodeActionProvider } from '../code_action_provider';
import { LINT_MARKER_SOURCE } from '../diagnostic_to_marker';

type LintMarker = monaco.editor.IMarkerData & {
  fix?: { title: string; text: string; range?: monaco.IRange };
};

const model = ({
  uri: monaco.Uri.parse('inmemory://model/q.ppl'),
  getVersionId: () => 1,
} as unknown) as monaco.editor.ITextModel;

function makeMarker(overrides: Partial<LintMarker> = {}): LintMarker {
  return {
    severity: monaco.MarkerSeverity.Warning,
    message: 'msg',
    startLineNumber: 1,
    startColumn: 5,
    endLineNumber: 1,
    endColumn: 10,
    source: LINT_MARKER_SOURCE,
    ...overrides,
  };
}

function provide(markers: LintMarker[]) {
  const result = pplLintCodeActionProvider.provideCodeActions(
    model,
    {} as monaco.Range,
    { markers, only: undefined, trigger: 1 } as monaco.languages.CodeActionContext
  ) as monaco.languages.CodeActionList;
  return result.actions;
}

// Pull the single text edit out of a code action for assertions.
function editOf(action: monaco.languages.CodeAction) {
  const edit = (action.edit as any).edits[0];
  return { range: edit.textEdit.range, text: edit.textEdit.text, resource: edit.resource };
}

describe('pplLintCodeActionProvider', () => {
  it('produces no action for a lint marker without a fix', () => {
    expect(provide([makeMarker()])).toHaveLength(0);
  });

  it('ignores non-lint markers even when they carry a fix', () => {
    const foreign = makeMarker({
      source: 'owner.syntax',
      fix: { title: 'T', text: 'x' },
    });
    expect(provide([foreign])).toHaveLength(0);
  });

  it('uses the marker bounds when the fix has no range', () => {
    const actions = provide([makeMarker({ fix: { title: 'Replace with "foo"', text: 'foo' } })]);
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe('Replace with "foo"');
    expect(actions[0].kind).toBe('quickfix');
    const edit = editOf(actions[0]);
    expect(edit.text).toBe('foo');
    expect(edit.resource).toBe(model.uri);
    expect(edit.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 10,
    });
  });

  it('uses the fix range when present, not the marker bounds', () => {
    const fixRange = { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 8 };
    const actions = provide([
      makeMarker({ fix: { title: 'Delete P', text: '', range: fixRange } }),
    ]);
    expect(actions).toHaveLength(1);
    const edit = editOf(actions[0]);
    expect(edit.text).toBe('');
    expect(edit.range).toEqual(fixRange);
  });

  it('emits one action per fixable marker', () => {
    const actions = provide([
      makeMarker({ fix: { title: 'fix-a', text: 'a' } }),
      makeMarker({ source: LINT_MARKER_SOURCE }), // no fix → skipped
      makeMarker({ fix: { title: 'fix-b', text: 'b' } }),
    ]);
    expect(actions.map((a) => a.title)).toEqual(['fix-a', 'fix-b']);
  });
});
