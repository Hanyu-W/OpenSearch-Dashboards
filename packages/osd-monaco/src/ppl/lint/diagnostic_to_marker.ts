/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';
import { Diagnostic, DiagnosticHoverFacts, DiagnosticRange, LintSeverity } from './diagnostic';

interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * Convert an ANTLR-convention {@link DiagnosticRange} (1-based line, 0-based
 * column, exclusive end) into Monaco coordinates (1-based line and column). It
 *  - shifts the 0-based ANTLR column to a 1-based Monaco column (+1) (R13.1),
 *  - clamps negative columns and sub-one lines (R13.2, R13.3),
 *  - keeps start <= end when both ends are on the same line.
 */
function toMonacoRange(range: DiagnosticRange): MonacoRange {
  const startLineNumber = Math.max(1, range.startLine);
  const endLineNumber = Math.max(startLineNumber, range.endLine);
  const startColumn = Math.max(1, range.startColumn + 1);
  let endColumn = Math.max(1, range.endColumn + 1);
  if (endLineNumber === startLineNumber) {
    endColumn = Math.max(startColumn, endColumn);
  }
  return { startLineNumber, startColumn, endLineNumber, endColumn };
}

/**
 * Marker source tag for all lint diagnostics. Used by the code-action provider
 * to distinguish lint markers from syntax-error markers.
 */
export const LINT_MARKER_SOURCE = 'ppl-lint';

/**
 * Marker source tag for syntax-error markers (owner `PPL_WORKER`). Lets the
 * code-action provider recognize the syntax channel and offer command-typo
 * quick-fixes there, without disturbing the lint channel (`ppl-lint`).
 */
export const SYNTAX_MARKER_SOURCE = 'ppl-syntax';

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
  const { startLineNumber, startColumn, endLineNumber, endColumn } = toMonacoRange(
    diagnostic.range
  );

  const marker: monaco.editor.IMarkerData = {
    severity: toMarkerSeverity(diagnostic.severity),
    message: diagnostic.message,
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    source: LINT_MARKER_SOURCE,
  };

  // The ruleId rides on `code` and is what the hover provider keys its rich-card
  // lookup on, so it must be set whenever a ruleId exists — independently of
  // whether the rule has a doc link. With a doc link we use the object form
  // `{ value, target }` (Monaco renders `target` as the marker's link); without
  // one we use the plain-string form (Monaco's `code` is `string | {…}`). The
  // hover provider reads both shapes.
  if (diagnostic.ruleId) {
    marker.code = diagnostic.docUrl
      ? { value: diagnostic.ruleId, target: monaco.Uri.parse(diagnostic.docUrl) }
      : diagnostic.ruleId;
  }

  // Attach the quick-fix payload the code-action provider reads off the marker.
  // An explicit fix range is converted to Monaco coordinates here; when absent,
  // the provider falls back to the marker's own range.
  if (diagnostic.fix) {
    (marker as monaco.editor.IMarkerData & {
      fix?: { title: string; text: string; range?: MonacoRange };
    }).fix = {
      title: diagnostic.fix.title,
      text: diagnostic.fix.text,
      range: diagnostic.fix.range ? toMonacoRange(diagnostic.fix.range) : undefined,
    };
  }

  // Attach per-instance hover facts the same way. Like `fix`, this transient
  // property does not survive Monaco's MarkerService rebuild; `language.ts`
  // moves it into the hover side table before calling `setModelMarkers`.
  if (diagnostic.hoverFacts) {
    (marker as monaco.editor.IMarkerData & {
      hoverFacts?: DiagnosticHoverFacts;
    }).hoverFacts = diagnostic.hoverFacts;
  }

  return marker;
}
