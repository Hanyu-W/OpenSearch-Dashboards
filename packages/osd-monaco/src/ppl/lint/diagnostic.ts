/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializable lint types for the PPL linter.
 *
 * These shapes are plain, JSON / `postMessage`-serializable objects. They carry
 * NO Monaco types and NO class instances, so they can cross the Web Worker
 * boundary unchanged. Monaco marker types are produced only on the main thread
 * in `diagnostic_to_marker.ts`.
 */

export type LintSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticRange {
  startLine: number; // ANTLR 1-based line
  startColumn: number; // ANTLR 0-based column
  endLine: number; // ANTLR 1-based line
  endColumn: number; // ANTLR 0-based, exclusive end column
}

export interface Diagnostic {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  range: DiagnosticRange;
  docUrl?: string;
}

/**
 * Declarative rule metadata. On the simplified-grammar path this is the
 * CLIENT-SIDE source of truth (no server bundle ships it).
 */
export interface LintRuleMetadata {
  id: string;
  severity: LintSeverity;
  message: string;
  docUrl: string;
}

/**
 * Returned by `PPLLanguageAnalyzer.lint()` and the worker; `postMessage`-serializable
 * (plain objects only — no class instances, no Monaco types cross the worker boundary).
 */
export interface LintResult {
  diagnostics: Diagnostic[];
}
