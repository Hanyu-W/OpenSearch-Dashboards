/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ParserRuleContext, Token } from 'antlr4ng';
import { Diagnostic, DiagnosticRange } from './diagnostic';

/**
 * Synthetic prefix prepended when a query begins with a leading pipe, so the
 * grammar (which expects a `source=` first) can parse it. Both lint surfaces
 * use the same string; the column offset is undone by
 * {@link remapPipeFirstColumns}.
 */
export const PIPE_FIRST_PREFIX = 'source=t ';

/**
 * Build a {@link DiagnosticRange} from a start and stop token.
 *
 * ANTLR tokens expose `line` (1-based) and `column` (0-based). `endColumn` is
 * exclusive: it is the stop token's column plus the token text length.
 */
export function rangeFromTokens(start: Token, stop: Token): DiagnosticRange {
  const startLine = start.line;
  const startColumn = start.column;
  const stopText = stop.text ?? '';
  const endLine = stop.line;
  const endColumn = stop.column + stopText.length;
  return { startLine, startColumn, endLine, endColumn };
}

/**
 * Build a {@link DiagnosticRange} spanning the full extent of a parser rule
 * context. Falls back to a 1:0 single-character range when token positions are
 * unavailable.
 */
export function rangeFromContext(ctx: ParserRuleContext): DiagnosticRange {
  const start = ctx.start;
  const stop = ctx.stop ?? ctx.start;
  if (!start || !stop) {
    return { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 };
  }
  return rangeFromTokens(start, stop);
}

/**
 * Build a {@link DiagnosticRange} for a substring within a single-line token's
 * text, given a 0-based offset into the token text and a length. Used to point
 * a diagnostic at a specific capture-group name inside a regex string literal.
 */
export function rangeWithinToken(
  token: Token,
  offsetInText: number,
  length: number
): DiagnosticRange {
  const text = token.text ?? '';
  // Count newlines before the offset to compute the line within the token.
  const before = text.slice(0, offsetInText);
  const newlineCount = (before.match(/\n/g) ?? []).length;
  const startLine = token.line + newlineCount;
  let startColumn: number;
  if (newlineCount === 0) {
    startColumn = token.column + offsetInText;
  } else {
    const lastNewline = before.lastIndexOf('\n');
    startColumn = offsetInText - lastNewline - 1;
  }
  return {
    startLine,
    startColumn,
    endLine: startLine,
    endColumn: startColumn + length,
  };
}

/**
 * Build a {@link DiagnosticRange} spanning the entire query text. Explain-backed
 * diagnostics have no source position (the plan text carries none), so they
 * cover the whole query. Computed from the text — rather than a sentinel like
 * `endColumn: Infinity` — so Monaco receives a concrete, in-bounds range.
 * `endColumn` is exclusive, matching the {@link DiagnosticRange} convention.
 */
export function wholeQueryRange(query: string): DiagnosticRange {
  const lines = query.split('\n');
  const endLine = Math.max(1, lines.length);
  const lastLine = lines[lines.length - 1] ?? '';
  return {
    startLine: 1,
    startColumn: 0,
    endLine,
    endColumn: lastLine.length,
  };
}

/**
 * Strip a single layer of matching surrounding quotes (single or double) from a
 * string-literal token's raw text. Returns the input unchanged when it is not
 * quoted.
 */
export function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * Subtract the synthetic {@link PIPE_FIRST_PREFIX} length from line-one
 * diagnostic columns, clamped to a minimum of zero (R13.6). Other lines are
 * unchanged. Applied by both lint surfaces (the compiled analyzer and the
 * runtime-bundle path) when a query was parsed with the pipe-first prefix, so
 * squiggles land on the same column as the user's text. An explicit fix range
 * gets the same shift; a default-range fix rides the already-remapped
 * diagnostic range via the provider fallback.
 */
export function remapPipeFirstColumns(diagnostics: Diagnostic[]): Diagnostic[] {
  const prefixLength = PIPE_FIRST_PREFIX.length;
  const shift = (range: DiagnosticRange): DiagnosticRange => ({
    ...range,
    startColumn:
      range.startLine === 1 ? Math.max(0, range.startColumn - prefixLength) : range.startColumn,
    endColumn: range.endLine === 1 ? Math.max(0, range.endColumn - prefixLength) : range.endColumn,
  });
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    range: shift(diagnostic.range),
    fix: diagnostic.fix?.range
      ? { ...diagnostic.fix, range: shift(diagnostic.fix.range) }
      : diagnostic.fix,
  }));
}
