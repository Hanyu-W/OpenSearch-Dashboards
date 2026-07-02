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
import { AI_FIX_COMMAND_ID } from '../../ai_fix/ai_fix_command_id';

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

/** A lint context under which the AI action is available (AI on + an index). */
function setAiContext(overrides: Partial<PPLLintContext> = {}) {
  setPPLLintContext(model, ({
    enableAIFeatures: true,
    datasetTitle: 'accounts',
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

  describe('AI "Ask Olly to fix" action on the card', () => {
    const aiMarker = () =>
      makeMarker({
        code: {
          value: 'type-mismatch-numeric',
          target: monaco.Uri.parse('https://docs.example/t'),
        },
        message: 'Comparing numeric field to a string literal.',
      });

    it('renders a trusted AI-fix command link for an AI-fixable rule when AI is available', () => {
      markersByOwner[LINT_OWNER] = [aiMarker()];
      setAiContext();
      const hover = hoverAt(1, 7);
      const md = markdownOf(hover);
      expect(md).toContain('✨ Ask Olly to fix this');
      expect(md).toContain(`command:${AI_FIX_COMMAND_ID}?`);
      // The args carry the rule + message so the handler re-validates the fix.
      const encoded = md.substring(md.indexOf(`command:${AI_FIX_COMMAND_ID}?`)).split(')')[0];
      const decoded = JSON.parse(decodeURIComponent(encoded.split('?')[1])) as {
        modelUri: string;
        ruleId: string;
        message: string;
      };
      expect(decoded.ruleId).toBe('type-mismatch-numeric');
      expect(decoded.modelUri).toBe(model.uri.toString());
      // Only that one command is trusted — never a blanket isTrusted:true.
      expect(trustedOf(hover)).toEqual({ enabledCommands: [AI_FIX_COMMAND_ID] });
    });

    it('does not offer the AI action when AI features are disabled', () => {
      markersByOwner[LINT_OWNER] = [aiMarker()];
      setAiContext({ enableAIFeatures: false });
      const hover = hoverAt(1, 7);
      expect(markdownOf(hover)).not.toContain('Ask Olly to fix this');
      expect(trustedOf(hover)).toBe(false);
    });

    it('does not offer the AI action when no index (datasetTitle) is known', () => {
      markersByOwner[LINT_OWNER] = [aiMarker()];
      setAiContext({ datasetTitle: undefined });
      expect(markdownOf(hoverAt(1, 7))).not.toContain('Ask Olly to fix this');
    });

    it('offers AI for ANY no-fix rule, including ones outside the old allowlist', () => {
      // division-by-zero was never in the old AI allowlist, but with no
      // deterministic fix it now gets the AI fallback under "offer on all".
      markersByOwner[LINT_OWNER] = [makeMarker()]; // division-by-zero, no fix in table
      setAiContext();
      const md = markdownOf(hoverAt(1, 7));
      expect(md).toContain('✨ Ask Olly to fix this');
      expect(md).toContain(`command:${AI_FIX_COMMAND_ID}?`);
    });

    it('prefers a deterministic fix and omits the AI action when one exists', () => {
      const marker = aiMarker();
      markersByOwner[LINT_OWNER] = [marker];
      setAiContext();
      setModelFixes(
        model,
        new Map([[markerFixKey(marker), { title: 'Quote the literal', text: 'age = "30"' }]])
      );
      const md = markdownOf(hoverAt(1, 7));
      expect(md).toContain('**Suggested fix** →');
      expect(md).not.toContain('Ask Olly to fix this');
    });

    it('does not offer the AI action when there is no lint context at all', () => {
      markersByOwner[LINT_OWNER] = [aiMarker()];
      // no setAiContext() → getPPLLintContext returns undefined
      expect(markdownOf(hoverAt(1, 7))).not.toContain('Ask Olly to fix this');
    });
  });
});
