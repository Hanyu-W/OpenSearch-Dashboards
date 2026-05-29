/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as antlr from 'antlr4ng';
import {
  SimplifiedOpenSearchPPLLexer as OpenSearchPPLLexer,
  SimplifiedOpenSearchPPLParser as OpenSearchPPLParser,
} from '@osd/antlr-grammar';
import { PPLSyntaxErrorListener, SyntaxError } from './ppl_error_listener';
import type { Diagnostic, LintResult } from './lint/diagnostic';
import { runLint } from './lint/lint_runner';

// Constant synthetic prefix for pipe-first fragments. Verified against the
// simplified grammar: `source=<ID>` is a valid searchCommand/pplCommands start,
// and the lexer's ID_LITERAL forbids a single leading '_', so we use the plain
// letter identifier 't'. NO newline -> only line-1 columns shift on remap.
const PIPE_FIRST_PREFIX = 'source=t ';

export interface PPLToken {
  type: string;
  value: string;
  startIndex: number;
  stopIndex: number;
  line: number;
  column: number;
}

export interface PPLValidationResult {
  isValid: boolean;
  errors: SyntaxError[];
}

export interface PPLCompletionItem {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

/**
 * PPL Language Analyzer - provides tokenization, validation, and code completion for PPL queries
 * Uses ANTLR generated lexer and parser for accurate language processing
 */
export class PPLLanguageAnalyzer {
  constructor() {
    // ANTLR-based language analyzer initialization
  }

  /**
   * Creates and configures ANTLR lexer and token stream from input code
   */
  private createLexerAndTokenStream(
    code: string
  ): { lexer: OpenSearchPPLLexer; tokenStream: antlr.CommonTokenStream } {
    const inputStream = antlr.CharStream.fromString(code);
    const lexer = new OpenSearchPPLLexer(inputStream);
    const tokenStream = new antlr.CommonTokenStream(lexer);
    return { lexer, tokenStream };
  }

  /**
   * Creates and configures ANTLR parser with error listeners
   */
  private createParserWithErrorHandling(
    tokenStream: antlr.CommonTokenStream
  ): {
    parser: OpenSearchPPLParser;
    lexerErrorListener: PPLSyntaxErrorListener;
    parserErrorListener: PPLSyntaxErrorListener;
  } {
    const parser = new OpenSearchPPLParser(tokenStream);

    // Set up error listeners
    const lexerErrorListener = new PPLSyntaxErrorListener();
    const parserErrorListener = new PPLSyntaxErrorListener();

    parser.removeErrorListeners();
    parser.addErrorListener(parserErrorListener);

    return { parser, lexerErrorListener, parserErrorListener };
  }

  /**
   * Tokenize PPL code into tokens using ANTLR lexer
   */
  tokenize(code: string): PPLToken[] {
    const tokens: PPLToken[] = [];

    try {
      const { lexer, tokenStream } = this.createLexerAndTokenStream(code);
      tokenStream.fill();

      const antlrTokens = tokenStream.getTokens();

      for (const token of antlrTokens) {
        if (token.type !== antlr.Token.EOF) {
          const tokenTypeName = this.getTokenTypeName(token.type, lexer);
          tokens.push({
            type: tokenTypeName,
            value: token.text || '',
            startIndex: token.start,
            stopIndex: token.stop,
            line: token.line,
            column: token.column,
          });
        }
      }
    } catch (error) {
      // Silent error handling for tokenization issues
    }

    return tokens;
  }

  /**
   * Validate PPL code using ANTLR parser
   */
  validate(code: string): PPLValidationResult {
    try {
      const { lexer, tokenStream } = this.createLexerAndTokenStream(code);

      // Add error listener to lexer
      const lexerErrorListener = new PPLSyntaxErrorListener();
      lexer.removeErrorListeners();
      lexer.addErrorListener(lexerErrorListener);

      const { parser, parserErrorListener } = this.createParserWithErrorHandling(tokenStream);

      parser.root();

      // Collect all errors from both lexer and parser
      const allErrors = [...lexerErrorListener.errors, ...parserErrorListener.errors];

      if (allErrors.length > 0) {
        return {
          isValid: false,
          errors: allErrors,
        };
      }

      return {
        isValid: true,
        errors: [],
      };
    } catch (error) {
      // Return parsing exception as error
      return {
        isValid: false,
        errors: [
          {
            message: error instanceof Error ? error.message : String(error),
            line: 1,
            column: 0,
            endLine: 1,
            endColumn: 1,
          },
        ],
      };
    }
  }

  /**
   * Lint PPL code on the compiled simplified-grammar path.
   *
   * Lint runs REGARDLESS of syntax errors: `parser.root()` returns an
   * error-recovery tree, and a cleanly-parsed rex stage is flagged even when an
   * unrelated syntax error exists elsewhere in the query. There is no
   * syntax-clean gate. Returns `{ diagnostics: [] }` only on a thrown parse
   * exception. Pipe-first fragments are made reliably parseable by a constant
   * source-prefix prepend, then diagnostic columns are remapped back to the
   * original content.
   */
  lint(code: string): LintResult {
    try {
      // Pipe-first fragments (e.g. `| rex field=m pattern="(?<a_b>x)"`) do not
      // start with pplCommands, so ANTLR error recovery at the very first token
      // is unreliable and may not descend into the rex stage. Prepend a synthetic
      // source so the fragment parses into a clean rexExpr node.
      const isPipeFirst = code.trimStart().startsWith('|');
      const parseInput = isPipeFirst ? PIPE_FIRST_PREFIX + code : code;

      const { tokenStream } = this.createLexerAndTokenStream(parseInput);
      const { parser } = this.createParserWithErrorHandling(tokenStream);

      // Error-recovery tree — lint does NOT read parser/lexer error counts. Even
      // if the query has a syntax error elsewhere, root() returns a walkable tree
      // and runLint flags any cleanly-parsed offending rex stage.
      const tree = parser.root();

      const diagnostics = runLint(tree);
      return {
        diagnostics: isPipeFirst
          ? remapPipeFirstDiagnostics(diagnostics, PIPE_FIRST_PREFIX.length)
          : diagnostics,
      };
    } catch (error) {
      // HARD parse exception only — not a syntax error in the query text.
      return { diagnostics: [] };
    }
  }

  /**
   * Get token type name from ANTLR token type
   */
  private getTokenTypeName(tokenType: number, lexer: OpenSearchPPLLexer): string {
    const vocabulary = lexer.vocabulary;
    const symbolicName = vocabulary.getSymbolicName(tokenType);

    if (symbolicName) {
      return symbolicName.toLowerCase();
    }

    const literalName = vocabulary.getLiteralName(tokenType);
    if (literalName) {
      return literalName.replace(/['"]/g, '');
    }

    return 'unknown';
  }
}

/**
 * Inverse of the runtime path's `remapErrors`: the synthetic prefix added no
 * newline, so ONLY line-1 columns shift. Subtract the prefix length from the
 * start/end columns of any diagnostic token on line 1, clamped at 0 (ANTLR
 * 0-based columns must never go negative). Diagnostics on later lines are
 * returned unchanged.
 */
function remapPipeFirstDiagnostics(diagnostics: Diagnostic[], prefixLen: number): Diagnostic[] {
  return diagnostics.map((d) => ({
    ...d,
    range: {
      ...d.range,
      startColumn:
        d.range.startLine === 1
          ? Math.max(0, d.range.startColumn - prefixLen)
          : d.range.startColumn,
      endColumn:
        d.range.endLine === 1 ? Math.max(0, d.range.endColumn - prefixLen) : d.range.endColumn,
    },
  }));
}

/**
 * Singleton instance of PPL Language Analyzer
 * Provides a shared instance for efficient memory usage across the application
 */
let pplLanguageAnalyzerInstance: PPLLanguageAnalyzer | null = null;

/**
 * Get or create the singleton instance of PPL Language Analyzer
 */
export const getPPLLanguageAnalyzer = (): PPLLanguageAnalyzer => {
  if (!pplLanguageAnalyzerInstance) {
    pplLanguageAnalyzerInstance = new PPLLanguageAnalyzer();
  }
  return pplLanguageAnalyzerInstance;
};
