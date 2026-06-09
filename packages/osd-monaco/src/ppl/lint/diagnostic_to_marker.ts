/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';
import { Diagnostic, LintSeverity } from './diagnostic';

/**
 * Marker source tag for all lint diagnostics. Used by the code-action provider
 * to distinguish lint markers from syntax-error markers.
 */
export const LINT_MARKER_SOURCE = 'ppl-lint';

function toMarkerSeverity(severity: LintSeverity): monaco.MarkerSeverity {
  switch (severity) {
    case 'error':
      return monaco.MarkerSeverity.Error;
    case 'warning':
      return monaco.MarkerSeverity.Warning;
    case 'info':
    default:
      return monaco.MarkerSeverity.Info;
  }
}

/**
 * Convert a {@link Diagnostic} into a Monaco marker.
 *
 * This is the single ANTLR→Monaco conversion for the lint path, distinct from
 * the syntax-error conversion in `language.ts`. It:
 *  - shifts the 0-based ANTLR column to a 1-based Monaco column (+1),
 *  - clamps inverted/negative ranges to non-negative bounds,
 *  - clamps sub-one lines to one,
 *  - maps severity,
 *  - sets `source: 'ppl-lint'`,
 *  - sets `code: { value: ruleId, target: docUrl }` when a doc URL is present.
 */
export function diagnosticToMarker(diagnostic: Diagnostic): monaco.editor.IMarkerData {
  const { range } = diagnostic;

  // Clamp lines to a minimum of 1 (R13.3).
  const startLine = Math.max(1, range.startLine);
  const endLine = Math.max(startLine, range.endLine);

  // Shift 0-based ANTLR columns to 1-based Monaco columns (R13.1), clamping
  // negatives (R13.2).
  const startColumn = Math.max(1, range.startColumn + 1);
  let endColumn = Math.max(1, range.endColumn + 1);

  // When start and end are on the same line, ensure start is not after end (R13.2).
  if (endLine === startLine) {
    endColumn = Math.max(startColumn, endColumn);
  }

  const marker: monaco.editor.IMarkerData = {
    severity: toMarkerSeverity(diagnostic.severity),
    message: diagnostic.message,
    startLineNumber: startLine,
    startColumn,
    endLineNumber: endLine,
    endColumn,
    source: LINT_MARKER_SOURCE,
  };

  if (diagnostic.docUrl) {
    marker.code = {
      value: diagnostic.ruleId,
      target: monaco.Uri.parse(diagnostic.docUrl),
    };
  }

  return marker;
}
