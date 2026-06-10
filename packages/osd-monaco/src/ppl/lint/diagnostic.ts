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
 * A deterministic quick-fix attached to a diagnostic. The code-action provider
 * turns it into a Monaco workspace edit. Fixes are opt-in suggestions: they are
 * attached only when the rewrite is unambiguous and would not re-fire the same
 * diagnostic, and the `title` shows the resulting text so the user previews the
 * change before accepting.
 */
export interface DiagnosticFix {
  /** Human-readable action title shown in the lightbulb menu. */
  title: string;
  /** Replacement text for the fix range. */
  text: string;
  /**
   * Source range the fix replaces. When omitted, the fix replaces the
   * diagnostic's own `range` (the common case). Same coordinate convention as
   * {@link DiagnosticRange} (1-based line, 0-based column, exclusive end).
   */
  range?: DiagnosticRange;
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
  /** Optional deterministic quick-fix. Absent for rules with no safe rewrite. */
  fix?: DiagnosticFix;
}

/**
 * The result of a lint pass over a single piece of content.
 */
export interface LintResult {
  diagnostics: Diagnostic[];
}
