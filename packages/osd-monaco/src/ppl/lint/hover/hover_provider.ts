/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import { LINT_MARKER_SOURCE } from '../diagnostic_to_marker';
import { getModelFix, markerFixKey } from '../fix_registry';
import { getModelHoverFacts } from './hover_registry';
import { getRuleHoverContent } from './engine_outcomes';
import { renderHoverCard, SeverityLabel } from './hover_card';

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

/**
 * The ruleId rides on `code`: either the plain-string form (a rule with no doc
 * link) or `code.value` (the object form, with a link). Returns undefined when
 * code is absent.
 */
function ruleIdOf(marker: monaco.editor.IMarker): string | undefined {
  const code = marker.code;
  if (typeof code === 'string') {
    return code;
  }
  if (code && typeof code === 'object' && typeof code.value === 'string') {
    return code.value;
  }
  return undefined;
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

    const value = renderHoverCard({
      ruleId: ruleId ?? 'ppl-lint',
      severityLabel: severityLabel(marker.severity),
      message: marker.message,
      docUrl: docUrlOf(marker),
      content: ruleId ? getRuleHoverContent(ruleId) : undefined,
      facts,
      fixText: fix?.text,
    });

    return {
      range: {
        startLineNumber: marker.startLineNumber,
        startColumn: marker.startColumn,
        endLineNumber: marker.endLineNumber,
        endColumn: marker.endColumn,
      },
      contents: [{ value, isTrusted: false }],
    };
  },
};
