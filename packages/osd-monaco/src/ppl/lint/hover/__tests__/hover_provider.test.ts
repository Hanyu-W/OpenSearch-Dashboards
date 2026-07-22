/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../../monaco';
import { LINT_MARKER_SOURCE } from '../../diagnostic_to_marker';
import { markerFixKey, MarkerFix, setModelFixes, clearModelFixes } from '../../fix_registry';
import { setModelHoverFacts, clearModelHoverFacts, HoverFacts } from '../hover_registry';
import { pplLintHoverProvider, LINT_OWNER } from '../hover_provider';
import { setPPLLintContext, clearPPLLintContext, PPLLintContext } from '../../../lint_bridge';
import {
  PPLLintTelemetryEvent,
  markerTelemetryId,
  PPL_LINT_TELEMETRY_EVENTS,
  PPL_LINT_UNKNOWN_RULE,
  registerPPLLintTelemetry,
  resetPPLLintTelemetryDedup,
} from '../../telemetry';

type Marker = monaco.editor.IMarker;

const model = {
  uri: monaco.Uri.parse('inmemory://model/q.ppl'),
} as unknown as monaco.editor.ITextModel;

function makeMarker(overrides: Partial<Marker> = {}): Marker {
  return {
    owner: LINT_OWNER,
    resource: model.uri,
    severity: monaco.MarkerSeverity.Warning,
    message: 'msg',
    startLineNumber: 1,
    startColumn: 5,
    endLineNumber: 1,
    endColumn: 12,
    source: LINT_MARKER_SOURCE,
    code: { value: 'division-by-zero', target: monaco.Uri.parse('https://docs.example/x') },
    ...overrides,
  } as unknown as Marker;
}

// Stub getModelMarkers to return our test markers, mirroring how the lint
// lifecycle would have published them. Returns [] for any other owner so the
// provider's owner filter is exercised.
let markersByOwner: Record<string, Marker[]> = {};
beforeEach(() => {
  markersByOwner = {};
  jest
    .spyOn(monaco.editor, 'getModelMarkers')
    .mockImplementation((filter: { owner?: string }) => markersByOwner[filter.owner ?? ''] ?? []);
});
afterEach(() => {
  jest.restoreAllMocks();
  clearModelFixes(model);
  clearModelHoverFacts(model);
  clearPPLLintContext(model);
});

/** A lint context under which the AI action is available (AI on + chat opener). */
function setAiContext(overrides: Partial<PPLLintContext> = {}) {
  setPPLLintContext(model, {
    enableAIFeatures: true,
    datasetTitle: 'accounts',
    onAskAiFix: jest.fn(),
    ...overrides,
  } as unknown as PPLLintContext);
}

/** The `isTrusted` field of the hover's first content part. */
function trustedOf(hover: monaco.languages.Hover | null) {
  if (!hover) return undefined;
  return (hover.contents[0] as monaco.IMarkdownString).isTrusted;
}

function hoverAt(line: number, column: number) {
  return pplLintHoverProvider.provideHover!(
    model,
    new monaco.Position(line, column),
    { isCancellationRequested: false } as unknown as monaco.CancellationToken,
    undefined
  ) as monaco.languages.Hover | null;
}

function markdownOf(hover: monaco.languages.Hover | null): string {
  if (!hover) return '';
  const first = hover.contents[0] as monaco.IMarkdownString;
  return first.value;
}

describe('pplLintHoverProvider', () => {
  it('returns a card for a lint marker under the cursor', () => {
    markersByOwner[LINT_OWNER] = [makeMarker()];
    const hover = hoverAt(1, 7);
    expect(hover).not.toBeNull();
    expect(markdownOf(hover)).toContain('**division-by-zero** · Warning');
    expect(markdownOf(hover)).toContain('**Engine behavior** —');
  });

  it('returns null when the cursor is outside every marker range', () => {
    markersByOwner[LINT_OWNER] = [makeMarker({ startColumn: 5, endColumn: 8 })];
    expect(hoverAt(1, 20)).toBeNull();
  });

  it('returns null when there are no lint markers at all', () => {
    expect(hoverAt(1, 7)).toBeNull();
  });

  it('ignores markers whose source is not ppl-lint', () => {
    markersByOwner[LINT_OWNER] = [makeMarker({ source: 'owner.syntax' })];
    expect(hoverAt(1, 7)).toBeNull();
  });

  it('includes per-instance facts and a fix preview from the side tables', () => {
    const marker = makeMarker({
      code: { value: 'field-validation', target: monaco.Uri.parse('https://docs.example/f') },
      message: 'Unknown field "reveneu". Did you mean "revenue"?',
    });
    markersByOwner[LINT_OWNER] = [marker];
    const facts: HoverFacts = { field: 'reveneu', suggestion: 'revenue' };
    setModelHoverFacts(model, new Map([[markerFixKey(marker), facts]]));
    const fix: MarkerFix = { title: 'Replace with "revenue"', text: 'revenue' };
    setModelFixes(model, new Map([[markerFixKey(marker), fix]]));

    const md = markdownOf(hoverAt(1, 7));
    expect(md).toContain('Closest known field: `revenue`');
    expect(md).toContain('**Suggested fix** → `revenue`');
  });

  it('picks the innermost marker when several overlap', () => {
    const outer = makeMarker({
      startColumn: 1,
      endColumn: 30,
      code: { value: 'agg-on-text', target: monaco.Uri.parse('https://docs.example/a') },
      message: 'outer',
    });
    const inner = makeMarker({
      startColumn: 5,
      endColumn: 12,
      code: { value: 'division-by-zero', target: monaco.Uri.parse('https://docs.example/d') },
      message: 'inner',
    });
    markersByOwner[LINT_OWNER] = [outer, inner];
    const md = markdownOf(hoverAt(1, 7));
    expect(md).toContain('**division-by-zero**');
    expect(md).not.toContain('**agg-on-text**');
  });

  it('still renders when code (ruleId) is absent, using a fallback id', () => {
    const marker = makeMarker({ code: undefined, message: 'no code here' });
    markersByOwner[LINT_OWNER] = [marker];
    const md = markdownOf(hoverAt(1, 7));
    expect(md).toContain('no code here');
    // No static content, no doc link — but never throws / never blank.
    expect(md).not.toContain('**Engine behavior**');
  });

  describe('AI "Ask AI to fix" action is not on the hover card', () => {
    const aiMarker = () =>
      makeMarker({
        code: {
          value: 'type-mismatch-numeric',
          target: monaco.Uri.parse('https://docs.example/t'),
        },
        message: 'Comparing numeric field to a string literal.',
      });

    // The AI action was removed from the hover card to avoid offering the same
    // action twice — it lives solely in the ⌘. quick-fix menu now. Even when the
    // AI feature is fully available and the rule has no deterministic fix, the
    // card must not render the action or mark any command trusted.
    it('never renders the AI action even when AI is available and no fix exists', () => {
      markersByOwner[LINT_OWNER] = [aiMarker()];
      setAiContext();
      const hover = hoverAt(1, 7);
      expect(markdownOf(hover)).not.toContain('Ask AI to fix this');
      expect(markdownOf(hover)).not.toContain('command:');
      // No command link on the card → nothing is trusted.
      expect(trustedOf(hover)).toBe(false);
    });
  });

  describe('telemetry', () => {
    let events: PPLLintTelemetryEvent[];
    beforeEach(() => {
      events = [];
      registerPPLLintTelemetry((event) => events.push(event));
      // The dedup state is per-model and persists across provideHover calls; the
      // shared test model would otherwise leak dedup between tests. Reset it so
      // each test starts from a fresh lint pass.
      resetPPLLintTelemetryDedup(model);
    });
    afterEach(() => {
      registerPPLLintTelemetry(undefined);
      resetPPLLintTelemetryDedup(model);
    });

    it('emits hover_shown with the rule id and marker correlation id when a card is returned', () => {
      const marker = makeMarker();
      markersByOwner[LINT_OWNER] = [marker];
      hoverAt(1, 7);
      expect(events).toEqual([
        {
          name: PPL_LINT_TELEMETRY_EVENTS.HOVER_SHOWN,
          data: { rule: 'division-by-zero', marker: markerTelemetryId(markerFixKey(marker)) },
        },
      ]);
    });

    it('does not emit when no lint marker is under the cursor', () => {
      markersByOwner[LINT_OWNER] = [makeMarker({ startColumn: 5, endColumn: 8 })];
      hoverAt(1, 20);
      expect(events).toHaveLength(0);
    });

    it('emits hover_shown with the unknown-rule sentinel when the marker has no code', () => {
      const marker = makeMarker({ code: undefined });
      markersByOwner[LINT_OWNER] = [marker];
      hoverAt(1, 7);
      // Sentinel, not `undefined`: an undefined-valued key is dropped by
      // JSON.stringify and would arrive downstream as a missing field.
      expect(events).toEqual([
        {
          name: PPL_LINT_TELEMETRY_EVENTS.HOVER_SHOWN,
          data: { rule: PPL_LINT_UNKNOWN_RULE, marker: markerTelemetryId(markerFixKey(marker)) },
        },
      ]);
    });

    it('deduplicates repeated hovers over the same marker within a pass', () => {
      markersByOwner[LINT_OWNER] = [makeMarker()];
      // Monaco re-invokes provideHover per hover anchor (character position);
      // three hovers over the same marker must count as one.
      hoverAt(1, 6);
      hoverAt(1, 7);
      hoverAt(1, 8);
      expect(events).toHaveLength(1);
    });

    it('counts the hover again after a new lint pass resets the dedup', () => {
      markersByOwner[LINT_OWNER] = [makeMarker()];
      hoverAt(1, 7);
      resetPPLLintTelemetryDedup(model); // simulates a fresh marker set
      hoverAt(1, 7);
      expect(events).toHaveLength(2);
    });
  });
});
