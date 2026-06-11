/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import { Diagnostic } from '../diagnostic';
import { diagnosticToMarker } from '../diagnostic_to_marker';
import { pplLintCodeActionProvider } from '../code_action_provider';
import { clearModelFixes, markerFixKey, MarkerFix, setModelFixes } from '../fix_registry';

/**
 * Regression guard for the quick-fix marker-service round-trip.
 *
 * Monaco's MarkerService.`_toMarker` rebuilds every marker from a fixed field
 * list when `setModelMarkers` is called, dropping any custom property. A fix
 * hung directly off the marker therefore never reaches `provideCodeActions`.
 * The previous unit tests passed `fix` straight to the provider and so missed
 * this. Here we reproduce the real flow: convert a diagnostic, record its fix in
 * the side table (as the lint lifecycle does), then STRIP the marker exactly the
 * way Monaco does before handing it to the provider — and assert the quick fix
 * still appears.
 */

const model = ({
  uri: monaco.Uri.parse('inmemory://model/q.ppl'),
  getVersionId: () => 1,
} as unknown) as monaco.editor.ITextModel;

// The exact field set MarkerService._toMarker preserves (plus resource/owner,
// which are irrelevant to the provider). Anything else — including `fix` — is
// dropped. Mirroring it here keeps the test honest about Monaco's contract.
function stripLikeMonaco(marker: monaco.editor.IMarkerData): monaco.editor.IMarkerData {
  const {
    code,
    severity,
    message,
    source,
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    relatedInformation,
    tags,
  } = marker;
  return {
    code,
    severity,
    message,
    source,
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    relatedInformation,
    tags,
  };
}

// Mirror the extract-into-registry step performed in language.ts before
// setModelMarkers, returning the markers as Monaco would store them.
function publishMarkers(diagnostics: Diagnostic[]): monaco.editor.IMarkerData[] {
  const markers = diagnostics.map(diagnosticToMarker);
  const fixes = new Map<string, MarkerFix>();
  for (const marker of markers) {
    const withFix = marker as monaco.editor.IMarkerData & { fix?: MarkerFix };
    if (withFix.fix) {
      fixes.set(markerFixKey(marker), withFix.fix);
    }
  }
  setModelFixes(model, fixes);
  return markers.map(stripLikeMonaco);
}

function provide(markers: monaco.editor.IMarkerData[]) {
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

function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    ruleId: 'invalid-capture-group-name',
    severity: 'error',
    message: 'Invalid capture group name "bad-name".',
    range: { startLine: 1, startColumn: 30, endLine: 1, endColumn: 38 },
    ...overrides,
  };
}

describe('quick-fix marker round-trip', () => {
  afterEach(() => clearModelFixes(model));

  it('surfaces a default-range fix after the marker is stripped (the bug)', () => {
    const markers = publishMarkers([
      makeDiagnostic({ fix: { title: 'Remove invalid characters → "badname"', text: 'badname' } }),
    ]);
    // The stripped marker carries no `fix` property — proving the registry, not
    // the marker, is what makes the quick fix work.
    expect((markers[0] as any).fix).toBeUndefined();

    const actions = provide(markers);
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe('Remove invalid characters → "badname"');
    expect(actions[0].kind).toBe('quickfix');
    const edit = (actions[0].edit as any).edits[0].textEdit;
    expect(edit.text).toBe('badname');
    // Default range == the marker's own (squiggle) range, Monaco-shifted.
    expect(edit.range).toEqual({
      startLineNumber: 1,
      startColumn: 31,
      endLineNumber: 1,
      endColumn: 39,
    });
  });

  it('surfaces an explicit-range fix after the marker is stripped', () => {
    const markers = publishMarkers([
      makeDiagnostic({
        message: 'Python/PCRE named-group opener is invalid in Java regex.',
        fix: {
          title: 'Convert to Java named-group syntax "(?<…>"',
          text: '',
          range: { startLine: 1, startColumn: 32, endLine: 1, endColumn: 33 },
        },
      }),
    ]);
    const actions = provide(markers);
    expect(actions).toHaveLength(1);
    const edit = (actions[0].edit as any).edits[0].textEdit;
    expect(edit.text).toBe('');
    expect(edit.range).toEqual({
      startLineNumber: 1,
      startColumn: 33,
      endLineNumber: 1,
      endColumn: 34,
    });
  });

  it('offers no action for a diagnostic that carries no fix', () => {
    const markers = publishMarkers([makeDiagnostic()]);
    expect(provide(markers)).toHaveLength(0);
  });

  it('matches the right fix when multiple fixable markers coexist', () => {
    const markers = publishMarkers([
      makeDiagnostic({
        range: { startLine: 1, startColumn: 30, endLine: 1, endColumn: 38 },
        message: 'Unknown field "naem".',
        fix: { title: 'Replace with "name"', text: 'name' },
      }),
      makeDiagnostic({
        range: { startLine: 1, startColumn: 50, endLine: 1, endColumn: 58 },
        message: 'Invalid capture group name "bad-name".',
        fix: { title: 'Remove invalid characters → "badname"', text: 'badname' },
      }),
    ]);
    const actions = provide(markers);
    expect(actions.map((a) => a.title)).toEqual([
      'Replace with "name"',
      'Remove invalid characters → "badname"',
    ]);
  });
});
