/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';
import type { Diagnostic, LintSeverity } from './diagnostic';

const SEVERITY: Record<LintSeverity, monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
};

/**
 * Convert an ANTLR-shaped lint `Diagnostic` into a Monaco marker.
 *
 * This is the single place the ANTLR (0-based column) -> Monaco (1-based column)
 * conversion lives. Runs only on the main thread (it constructs Monaco types).
 * `Math.max` clamps guarantee a structurally-valid marker range so Monaco never
 * receives a degenerate range.
 */
export function diagnosticToMarker(d: Diagnostic): monaco.editor.IMarkerData {
  const startLine = Math.max(1, d.range.startLine);
  const endLine = Math.max(startLine, d.range.endLine);
  const startColumn = Math.max(1, d.range.startColumn + 1); // ANTLR 0-based -> Monaco 1-based
  const endColumn = Math.max(startColumn, d.range.endColumn + 1);

  return {
    severity: SEVERITY[d.severity],
    message: d.message,
    startLineNumber: startLine,
    endLineNumber: endLine,
    startColumn,
    endColumn,
    source: 'ppl-lint',
    code: d.docUrl ? { value: d.ruleId, target: monaco.Uri.parse(d.docUrl) } : d.ruleId,
  };
}
