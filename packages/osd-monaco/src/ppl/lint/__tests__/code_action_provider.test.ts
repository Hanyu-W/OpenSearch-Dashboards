/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import { pplLintCodeActionProvider } from '../code_action_provider';
import { LINT_MARKER_SOURCE, SYNTAX_MARKER_SOURCE } from '../diagnostic_to_marker';
import {
  clearModelFixes,
  clearModelSyntaxFixes,
  markerFixKey,
  MarkerFix,
  setModelFixes,
  setModelSyntaxFixes,
} from '../fix_registry';
import {
  PPLLintTelemetryEvent,
  markerTelemetryId,
  PPL_LINT_QUICKFIX_COMMAND_ID,
  PPL_LINT_TELEMETRY_EVENTS,
  registerPPLLintTelemetry,
  resetPPLLintTelemetryDedup,
} from '../telemetry';

type LintMarker = monaco.editor.IMarkerData;

let modelSlice = 'target';
const model = {
  uri: monaco.Uri.parse('inmemory://model/q.ppl'),
  getVersionId: () => 1,
  getValueInRange: () => modelSlice,
} as unknown as monaco.editor.ITextModel;

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

// Seed the side-table registry the way the lint lifecycle does, so the provider
// can re-associate a fix with a marker after Monaco strips custom marker fields.
function seedFix(marker: LintMarker, fix: MarkerFix) {
  const fixes = new Map<string, MarkerFix>();
  fixes.set(markerFixKey(marker), fix);
  setModelFixes(model, fixes);
}

function provide(markers: LintMarker[]) {
  const result = pplLintCodeActionProvider.provideCodeActions(
    model,
    {} as monaco.Range,
    { markers, only: undefined, trigger: 1 } as monaco.languages.CodeActionContext,
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as monaco.CancellationToken
  ) as monaco.languages.CodeActionList;
  return result.actions;
}

// Pull the single text edit out of a code action for assertions.
function editOf(action: monaco.languages.CodeAction) {
  const edit = (action.edit as any).edits[0];
  return { range: edit.textEdit.range, text: edit.textEdit.text, resource: edit.resource };
}

describe('pplLintCodeActionProvider', () => {
  afterEach(() => {
    modelSlice = 'target';
    clearModelFixes(model);
  });

  it('produces no action for a lint marker without a registered fix', () => {
    expect(provide([makeMarker()])).toHaveLength(0);
  });

  it('ignores non-lint markers even when a fix is registered for their key', () => {
    const foreign = makeMarker({ source: 'owner.syntax' });
    seedFix(foreign, { title: 'T', text: 'x' });
    expect(provide([foreign])).toHaveLength(0);
  });

  it('uses the marker bounds when the fix has no range', () => {
    const marker = makeMarker();
    seedFix(marker, { title: 'Replace with "foo"', text: 'foo' });
    const actions = provide([marker]);
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
    const marker = makeMarker();
    seedFix(marker, { title: 'Delete P', text: '', range: fixRange });
    const actions = provide([marker]);
    expect(actions).toHaveLength(1);
    const edit = editOf(actions[0]);
    expect(edit.text).toBe('');
    expect(edit.range).toEqual(fixRange);
  });

  it('offers an exact-text fix only while the current source slice still matches', () => {
    const marker = makeMarker();
    seedFix(marker, {
      title: 'Rewrite predicate',
      text: 'age > 32',
      expectedText: 'age - 2 > 30',
    });

    modelSlice = 'age - 2 > 30';
    expect(provide([marker])).toHaveLength(1);

    modelSlice = 'age - 3 > 30';
    expect(provide([marker])).toHaveLength(0);
  });

  it('emits one action per fixable marker, skipping markers with no registered fix', () => {
    // Distinct positions so each marker has a distinct registry key.
    const a = makeMarker({ startColumn: 1, endColumn: 2 });
    const none = makeMarker({ startColumn: 3, endColumn: 4 });
    const b = makeMarker({ startColumn: 5, endColumn: 6 });
    const fixes = new Map<string, MarkerFix>();
    fixes.set(markerFixKey(a), { title: 'fix-a', text: 'a' });
    fixes.set(markerFixKey(b), { title: 'fix-b', text: 'b' });
    setModelFixes(model, fixes);
    const actions = provide([a, none, b]);
    expect(actions.map((act) => act.title)).toEqual(['fix-a', 'fix-b']);
  });

  it('distinguishes two markers at the same position by message', () => {
    const m1 = makeMarker({ message: 'first' });
    const m2 = makeMarker({ message: 'second' });
    const fixes = new Map<string, MarkerFix>();
    fixes.set(markerFixKey(m1), { title: 'fix-1', text: '1' });
    fixes.set(markerFixKey(m2), { title: 'fix-2', text: '2' });
    setModelFixes(model, fixes);
    expect(provide([m1]).map((a) => a.title)).toEqual(['fix-1']);
    expect(provide([m2]).map((a) => a.title)).toEqual(['fix-2']);
  });

  describe('syntax-error channel (command-typo quick-fix)', () => {
    afterEach(() => clearModelSyntaxFixes(model));

    const syntaxMarker = (overrides: Partial<LintMarker> = {}): LintMarker =>
      makeMarker({ source: SYNTAX_MARKER_SOURCE, ...overrides });

    function seedSyntaxFix(marker: LintMarker, fix: MarkerFix) {
      const fixes = new Map<string, MarkerFix>();
      fixes.set(markerFixKey(marker), fix);
      setModelSyntaxFixes(model, fixes);
    }

    it('offers a quick-fix for a syntax marker with a registered syntax fix', () => {
      const marker = syntaxMarker({ message: 'Unknown command "wherre". Did you mean "where"?' });
      seedSyntaxFix(marker, { title: 'Replace with "where"', text: 'where' });
      const actions = provide([marker]);
      expect(actions).toHaveLength(1);
      expect(actions[0].title).toBe('Replace with "where"');
      expect(editOf(actions[0]).text).toBe('where');
    });

    it('does not read a syntax fix off the lint table (channels are separate)', () => {
      const marker = syntaxMarker();
      // Seed the LINT table for this key; the syntax channel must not see it.
      const lintFixes = new Map<string, MarkerFix>();
      lintFixes.set(markerFixKey(marker), { title: 'lint-fix', text: 'x' });
      setModelFixes(model, lintFixes);
      expect(provide([marker])).toHaveLength(0);
    });

    it('produces no action for a syntax marker without a registered fix', () => {
      expect(provide([syntaxMarker()])).toHaveLength(0);
    });
  });

  describe('telemetry', () => {
    let events: PPLLintTelemetryEvent[];
    beforeEach(() => {
      events = [];
      registerPPLLintTelemetry((event) => events.push(event));
      // Dedup is per-model and persists across provideCodeActions calls; reset
      // it so each test starts from a fresh lint pass on the shared model.
      resetPPLLintTelemetryDedup(model);
    });
    afterEach(() => {
      registerPPLLintTelemetry(undefined);
      clearModelSyntaxFixes(model);
      resetPPLLintTelemetryDedup(model);
    });

    it('emits quickfix_offered and attaches the click command for a lint fix', () => {
      const marker = makeMarker({ code: 'division-by-zero' });
      seedFix(marker, { title: 'Replace with "1"', text: '1' });
      const markerId = markerTelemetryId(markerFixKey(marker));
      const actions = provide([marker]);

      expect(actions).toHaveLength(1);
      // The offer carries the per-finding correlation id so it can be joined to
      // the click event.
      expect(events).toEqual([
        {
          name: PPL_LINT_TELEMETRY_EVENTS.QUICKFIX_OFFERED,
          data: { rule: 'division-by-zero', marker: markerId },
        },
      ]);
      // The action carries a command so a click can be recorded; Monaco applies
      // the edit first, then runs the command. The command args carry the same
      // rule + marker id so quickfix_clicked joins this offer.
      expect(actions[0].command).toEqual({
        id: PPL_LINT_QUICKFIX_COMMAND_ID,
        title: 'Replace with "1"',
        arguments: [{ rule: 'division-by-zero', marker: markerId }],
      });
    });

    it('does not carry a captured versionId (an edit rejected for a stale version would still fire quickfix_clicked)', () => {
      const marker = makeMarker({ code: 'division-by-zero' });
      seedFix(marker, { title: 'Replace with "1"', text: '1' });
      const actions = provide([marker]);
      const edit = (actions[0].edit as any).edits[0];
      expect(edit.versionId).toBeUndefined();
    });

    it('reads the rule id from the object-form code as well', () => {
      const marker = makeMarker({
        code: { value: 'agg-on-text', target: monaco.Uri.parse('https://docs.example/a') },
      });
      seedFix(marker, { title: 'fix', text: 'x' });
      provide([marker]);
      expect(events).toEqual([
        {
          name: PPL_LINT_TELEMETRY_EVENTS.QUICKFIX_OFFERED,
          data: { rule: 'agg-on-text', marker: markerTelemetryId(markerFixKey(marker)) },
        },
      ]);
    });

    it('does not emit or attach a command for a syntax-channel fix', () => {
      const marker = makeMarker({ source: SYNTAX_MARKER_SOURCE });
      const fixes = new Map<string, MarkerFix>();
      fixes.set(markerFixKey(marker), { title: 'Replace with "where"', text: 'where' });
      setModelSyntaxFixes(model, fixes);

      const actions = provide([marker]);
      expect(actions).toHaveLength(1);
      expect(actions[0].command).toBeUndefined();
      expect(events).toHaveLength(0);
    });

    it('emits quickfix_offered once per marker across repeated provider calls in a pass', () => {
      const marker = makeMarker({ code: 'division-by-zero' });
      seedFix(marker, { title: 'fix', text: 'x' });
      // Monaco auto-fires provideCodeActions on every cursor move; three calls
      // for the same fix must count as one offer, while still returning the
      // action every time so the fix stays available.
      expect(provide([marker])).toHaveLength(1);
      expect(provide([marker])).toHaveLength(1);
      expect(provide([marker])).toHaveLength(1);
      expect(events).toHaveLength(1);
    });

    it('counts quickfix_offered again after a new lint pass resets the dedup', () => {
      const marker = makeMarker({ code: 'division-by-zero' });
      seedFix(marker, { title: 'fix', text: 'x' });
      provide([marker]);
      resetPPLLintTelemetryDedup(model); // simulates a fresh marker set
      provide([marker]);
      expect(events).toHaveLength(2);
    });
  });
});
