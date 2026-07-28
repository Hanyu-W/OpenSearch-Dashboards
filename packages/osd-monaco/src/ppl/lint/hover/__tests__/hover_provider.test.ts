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

type Marker = monaco.editor.IMarker;

const model = ({
  uri: monaco.Uri.parse('inmemory://model/q.ppl'),
} as unknown) as monaco.editor.ITextModel;

function makeMarker(overrides: Partial<Marker> = {}): Marker {
  return ({
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
  } as unknown) as Marker;
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
  setPPLLintContext(model, ({
    enableAIFeatures: true,
    datasetTitle: 'accounts',
    onAskAiFix: jest.fn(),
    ...overrides,
  } as unknown) as PPLLintContext);
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
    ({ isCancellationRequested: false } as unknown) as monaco.CancellationToken,
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
    expect(markdownOf(hover)).toContain('⚠️ **Warning**');
    expect(markdownOf(hover)).toContain('**Fix** —');
    expect(markdownOf(hover)).not.toContain('division-by-zero');
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
    expect(md).not.toContain('Closest known field');
    expect(md).toContain('**Quick fix available** — `revenue`');
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
    expect(md).toContain('inner');
    expect(md).not.toContain('outer');
  });

  it('still renders when code (ruleId) is absent', () => {
    const marker = makeMarker({ code: undefined, message: 'no code here' });
    markersByOwner[LINT_OWNER] = [marker];
    const md = markdownOf(hoverAt(1, 7));
    expect(md).toContain('no code here');
    // No static content, no doc link — but never throws / never blank.
    expect(md).not.toContain('**Fix**');
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
});
