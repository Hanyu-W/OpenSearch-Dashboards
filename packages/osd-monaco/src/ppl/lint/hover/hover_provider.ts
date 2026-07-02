/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import { LINT_MARKER_SOURCE, ruleIdOf } from '../diagnostic_to_marker';
import { getModelFix, markerFixKey } from '../fix_registry';
import { getModelHoverFacts } from './hover_registry';
import { getRuleHoverContent } from './engine_outcomes';
import { renderHoverCard, SeverityLabel } from './hover_card';
import { getPPLLintContext } from '../../lint_bridge';
import { AI_FIX_COMMAND_ID, AiFixCommandArgs } from '../ai_fix/ai_fix_command_id';

/**
 * Marker owner for lint diagnostics. Must match `LINT_OWNER` in `language.ts`
 * (where `setModelMarkers` is called); kept in sync there. We query markers by
 * this owner so the hover never touches the syntax-error channel (`PPL_WORKER`).
 */
export const LINT_OWNER = 'PPL_LINT';

function severityLabel(severity: monaco.MarkerSeverity): SeverityLabel {
  switch (severity) {
    case monaco.MarkerSeverity.Error:
      return 'Error';
    case monaco.MarkerSeverity.Warning:
      return 'Warning';
    default:
      return 'Info';
  }
}

/** The specific doc link rides on `code.target` (object form only). */
function docUrlOf(marker: monaco.editor.IMarker): string | undefined {
  const code = marker.code;
  if (code && typeof code === 'object' && code.target) {
    return code.target.toString();
  }
  return undefined;
}

/** Is `position` within the marker's range (inclusive of the end column)? */
function markerContainsPosition(marker: monaco.editor.IMarker, position: monaco.Position): boolean {
  const { lineNumber, column } = position;
  if (lineNumber < marker.startLineNumber || lineNumber > marker.endLineNumber) {
    return false;
  }
  if (lineNumber === marker.startLineNumber && column < marker.startColumn) {
    return false;
  }
  if (lineNumber === marker.endLineNumber && column > marker.endColumn) {
    return false;
  }
  return true;
}

/** Width of a marker's range in (line, column) terms, for "innermost wins". */
function markerSpan(marker: monaco.editor.IMarker): number {
  const lineSpan = marker.endLineNumber - marker.startLineNumber;
  // Weight lines heavily so a single-line marker always beats a multi-line one.
  return lineSpan * 100000 + (marker.endColumn - marker.startColumn);
}

/**
 * Build the `command:` link target for the AI ("Ask Olly to fix") action, or
 * undefined when it should not be offered. Mirrors the code-action provider's
 * gate exactly (deterministic-first, AI-as-fallback: offered for ANY lint marker
 * that has no deterministic fix, with no per-rule allowlist, when AI features are
 * on and an index is known), so the hover card and the ⌘. menu agree on when the
 * action appears.
 *
 * The args match `AiFixCommandArgs` and are JSON-encoded into the link query;
 * Monaco's opener does `JSON.parse(decodeURIComponent(query))` and, since the
 * result is a plain object (not an array), passes it as the handler's first
 * argument — the exact shape `handleAiFixCommand` already receives from the
 * code-action command.
 */
function buildAiFixCommandUri(
  model: monaco.editor.ITextModel,
  marker: monaco.editor.IMarker,
  ruleId: string | undefined,
  hasDeterministicFix: boolean
): string | undefined {
  if (hasDeterministicFix) {
    return undefined;
  }
  const ctx = getPPLLintContext(model);
  const aiAvailable = ctx?.enableAIFeatures !== false && !!ctx?.datasetTitle;
  if (!aiAvailable) {
    return undefined;
  }
  const args: AiFixCommandArgs = {
    modelUri: model.uri.toString(),
    ruleId,
    message: marker.message,
  };
  return `command:${AI_FIX_COMMAND_ID}?${encodeURIComponent(JSON.stringify(args))}`;
}

/**
 * Hover provider for PPL lint markers. On hover it finds the `ppl-lint` marker
 * under the cursor (innermost when several overlap), looks up the rich card
 * content lazily — static content by ruleId, per-instance facts and the
 * quick-fix preview from the side tables keyed by marker position+message — and
 * returns a Markdown card. Returns null when no lint marker is under the cursor,
 * so Monaco's default/word hover still shows.
 *
 * All work here is lazy (only on hover); the lint pass adds no hover cost beyond
 * a Map write per finding (see `language.ts`).
 */
export const pplLintHoverProvider: monaco.languages.HoverProvider = {
  provideHover(model: monaco.editor.ITextModel, position: monaco.Position) {
    const markers = monaco.editor
      .getModelMarkers({ owner: LINT_OWNER, resource: model.uri })
      .filter((marker) => marker.source === LINT_MARKER_SOURCE)
      .filter((marker) => markerContainsPosition(marker, position));

    if (markers.length === 0) {
      return null;
    }

    // Innermost marker wins when several overlap at the position.
    const marker = markers.reduce((a, b) => (markerSpan(b) < markerSpan(a) ? b : a));

    const ruleId = ruleIdOf(marker);
    const key = markerFixKey(marker);
    const facts = getModelHoverFacts(model, key);
    const fix = getModelFix(model, key);

    // Offer the AI action inline on the card, gated identically to the ⌘. menu
    // (deterministic-first: only when no template fix exists and the rule is
    // AI-fixable with AI available). Its command link needs the command to be
    // trusted for this hover — allowlist just that one id, nothing else.
    const aiFixCommandUri = buildAiFixCommandUri(model, marker, ruleId, fix !== undefined);

    const value = renderHoverCard({
      ruleId: ruleId ?? 'ppl-lint',
      severityLabel: severityLabel(marker.severity),
      message: marker.message,
      docUrl: docUrlOf(marker),
      content: ruleId ? getRuleHoverContent(ruleId) : undefined,
      facts,
      fixText: fix?.text,
      aiFixCommandUri,
    });

    return {
      range: {
        startLineNumber: marker.startLineNumber,
        startColumn: marker.startColumn,
        endLineNumber: marker.endLineNumber,
        endColumn: marker.endColumn,
      },
      contents: [
        {
          value,
          // Only the AI-fix command is trusted, and only when it is actually on
          // the card; the doc "Learn more" link is a plain https URL and needs
          // no trust. An unconditional `isTrusted: true` would let any future
          // command link execute, so keep it to the single allowlisted id.
          isTrusted: aiFixCommandUri ? { enabledCommands: [AI_FIX_COMMAND_ID] } : false,
        },
      ],
    };
  },
};
