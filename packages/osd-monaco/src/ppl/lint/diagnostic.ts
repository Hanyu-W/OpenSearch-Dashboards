/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Severity of a lint diagnostic. Mirrors the engine-verified failure class:
 * `error` = deterministic engine failure, `warning` = may succeed via fallback,
 * `info` = advisory / nondeterminism.
 */
export type LintSeverity = 'error' | 'warning' | 'info';

/**
 * Source range for a diagnostic.
 *
 * Lines are 1-based (matching ANTLR/Monaco line numbering).
 * Columns are 0-based (ANTLR convention); they are converted to Monaco's
 * 1-based columns at marker-conversion time (see `diagnostic_to_marker.ts`).
 * `endColumn` is exclusive.
 */
export interface DiagnosticRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * A single linter finding emitted by a detector.
 */
export interface Diagnostic {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  range: DiagnosticRange;
  docUrl?: string;
}

/**
 * The result of a lint pass over a single piece of content.
 */
export interface LintResult {
  diagnostics: Diagnostic[];
}
