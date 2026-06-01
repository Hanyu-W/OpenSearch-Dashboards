/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// NOTE: we do NOT import any `*Context` type (e.g. RexExprContext) from
// '@osd/antlr-grammar' — the simplified-grammar barrel exports ONLY
// SimplifiedOpenSearchPPL{Lexer,Parser,ParserVisitor} and re-exports NO context
// types. We also do NOT import AbstractParseTreeVisitor directly: extending the
// typed visitor base (which already extends it) supplies defaultResult(). This
// matches the existing PPLSymbolTableParser precedent
// (src/plugins/data/public/antlr/opensearch_ppl/simplified_ppl_grammar/symbol_table_parser.ts),
// which types every visit-method ctx as `any` and stays osd-monaco-only.
import { SimplifiedOpenSearchPPLParserVisitor } from '@osd/antlr-grammar';
import type { Diagnostic, LintRuleMetadata } from '../diagnostic';

// Client-side rule catalog entry (server bundle path is cut for P0).
// Message/docUrl verbatim from the rex doc note.
// Note: for a `(?P<` input the underscore is flagged correctly, but the `(?P<`
// opener itself is also invalid Java regex — a separate concern — so the "use
// (?<errortype>)" suggestion addresses only the underscore. The message string
// is unchanged.
export const REX_NO_UNDERSCORE_METADATA: LintRuleMetadata = {
  id: 'rex-no-underscore',
  severity: 'warning',
  message:
    'Capture group names cannot contain underscores because of Java regex ' +
    'limitations. For example, (?<error_type>\\w+) is invalid; use ' +
    '(?<errortype>\\w+) instead.',
  docUrl: 'https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/rex/',
};

// Java named-capture group names are [A-Za-z][A-Za-z0-9]*. An underscore inside
// the NAME (between '<' and '>') is accepted by the PPL grammar as a string
// literal but rejected by java.util.regex.Pattern at execution. The rule is the
// underscore in the NAME, independent of opener flavor — so the `P` is optional
// and both `(?<` and `(?P<` openers are matched. Only the name portion (between
// '<' and '>') is inspected; underscores in the regex BODY are not matched.
const NAMED_CAPTURE_WITH_UNDERSCORE = /\(\?P?<[^>]*_[^>]*>/;

/**
 * Typed-base visitor over the compiled simplified grammar. Extends the generated
 * `SimplifiedOpenSearchPPLParserVisitor<void>` so the VISITOR REGISTRATION is
 * type-checked — `visitRexExpr` is a real visit hook on the generated base, not a
 * stray method. The `ctx` parameter itself is typed `any` (the generated
 * `RexExprContext` type is not exported from '@osd/antlr-grammar'), so member
 * access on `ctx` is NOT compile-checked. This is the same convention used by the
 * existing PPLSymbolTableParser, and keeps the change strictly osd-monaco-only.
 * Accumulates diagnostics; caller reads `diagnostics` after walking.
 */
export class RexNoUnderscoreVisitor extends SimplifiedOpenSearchPPLParserVisitor<void> {
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly metadata: LintRuleMetadata) {
    super();
  }

  // No defaultResult() override: the generated base already extends
  // AbstractParseTreeVisitor, whose defaultResult() is concrete (returns null),
  // so a <void> visitor compiles without it. Matches symbol_table_parser.ts.

  // Declared as an arrow-property because the generated base declares visit
  // methods as OPTIONAL properties (visitRexExpr?: (ctx) => Result), not abstract
  // methods. Assigning the property satisfies the base shape and binds `this`.
  // `ctx` is `any` (no exported RexExprContext type) — same as symbol_table_parser.ts.
  visitRexExpr = (ctx: any): void => {
    // ctx.stringLiteral() is the correct accessor on the generated RexExprContext
    // and works at runtime; it is untyped here because ctx is `any`.
    const literal = ctx.stringLiteral();
    if (!literal) return;

    const raw = literal.getText(); // includes surrounding quotes, e.g. "\"(?<user_id>\\d+)\""
    if (!NAMED_CAPTURE_WITH_UNDERSCORE.test(raw)) return;

    const start = literal.start;
    if (!start) return;
    const stop = literal.stop ?? start;

    this.diagnostics.push({
      ruleId: this.metadata.id,
      severity: this.metadata.severity,
      message: this.metadata.message,
      docUrl: this.metadata.docUrl,
      range: {
        startLine: start.line,
        startColumn: start.column, // ANTLR 0-based; converted at marker boundary
        endLine: stop.line,
        endColumn: stop.column + (stop.text?.length ?? 0),
      },
    });
  };
}
