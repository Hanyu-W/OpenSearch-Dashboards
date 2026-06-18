/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { CharStream, CommonTokenStream, LexerInterpreter, ParserInterpreter } from 'antlr4ng';
import { deserializeGrammar, lintRuntime, RawGrammarBundle } from './runtime_path';
import { buildCommandSuggestion } from '../../command_suggestion';
import { LintRunContext } from '../types';

// End-to-end verification against the REAL runtime grammar bundle captured from
// the live OpenSearch 3.7 cluster (244-rule server ATN). This is the production
// runtime surface (#3): the same deserialized ATN, LexerInterpreter +
// ParserInterpreter, and runLint/buildCommandSuggestion the browser runs. It
// proves both features fire on the surface users actually hit — not just the
// in-repo grammar proxies the unit tests use.
//
// Skips automatically if the bundle fixture is absent (so normal CI is
// unaffected); run explicitly after capturing a bundle.

const BUNDLE_PATH = path.join(__dirname, 'ppl_grammar_bundle.json');
const hasBundle = fs.existsSync(BUNDLE_PATH);
const describeIf = hasBundle ? describe : describe.skip;

describeIf('E2E on the live runtime grammar bundle', () => {
  const bundle = hasBundle
    ? (JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8')) as RawGrammarBundle)
    : ({} as RawGrammarBundle);
  let now = 0;
  const { grammar } = deserializeGrammar(bundle, () => ++now);

  // The shape pass only branches on grammarSurface; grammarHash is carried for
  // parity with production but is not load-bearing here. `RawGrammarBundle` (the
  // bench's bundle shape) doesn't declare it, so read it defensively.
  const grammarHash = (bundle as { grammarHash?: string }).grammarHash;
  function runtimeContext(): LintRunContext {
    return { grammarSurface: 'runtime-bundle', grammarHash };
  }

  describe('Feature B — field-slot shape (real runtime grammar)', () => {
    const shapeDiags = (query: string) =>
      lintRuntime(query, grammar, runtimeContext())
        .filter((d) => d.ruleId === 'field-validation')
        .map((d) => ({ message: d.message, severity: d.severity, fixText: d.fix?.text }));

    // On the OpenSearch `main` server grammar the grok/parse/patterns
    // source_field slot is the broad `expression` rule, so `grok field=body`
    // parses CLEANLY as a comparison (`Compare(field, =, body)`) — the silent
    // misparse that fails only at engine time with "Field [field] not found".
    // This is exactly the gap the shape pass fills: no syntax squiggle is drawn,
    // so without this lint the user gets no editor feedback. (A separate engine
    // branch narrowed the slot to `valueExpression` to reject `field=` as a
    // syntax error; this lint is the OSD-side alternative to that.)
    it('flags grok field=body and offers a "body" fix (the Splunk typo)', () => {
      const diags = shapeDiags('source=accounts | grok field=body "%{NUMBER}"');
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe('error');
      expect(diags[0].fixText).toBe('body');
      expect(diags[0].message).toContain('grok');
    });

    it('flags parse field=message with a fix to the bare field', () => {
      const diags = shapeDiags('source=accounts | parse field=message "%{NUMBER}"');
      expect(diags).toHaveLength(1);
      expect(diags[0].fixText).toBe('message');
    });

    it('does NOT flag a valid bare field reference (grok body)', () => {
      expect(shapeDiags('source=accounts | grok body "%{NUMBER}"')).toEqual([]);
    });
  });

  describe('Feature A — command-typo suggestion (runtime ParserInterpreter)', () => {
    const commandsRule = grammar.parserRuleNames.indexOf('commands');

    // Mirror production runtime_validation.ts: a pipe-first query strips the
    // leading pipe and parses from the `commands` rule (pickStartRuleIndex);
    // a source-prefixed query parses from `root`. The command-keyword follow-set
    // (and thus the suggestion) is only reachable from `commands` on the real
    // server grammar, so this is the path that fires in production.
    function firstSuggestion(query: string) {
      const isPipeFirst = query.trimStart().startsWith('|');
      const effective = isPipeFirst ? query.slice(query.indexOf('|') + 1) : query;
      const startRule = isPipeFirst ? commandsRule : grammar.startRuleIndex ?? 0;

      const lexer = new LexerInterpreter(
        'PPL',
        grammar.vocabulary,
        grammar.lexerRuleNames,
        grammar.channelNames,
        grammar.modeNames,
        grammar.lexerATN,
        CharStream.fromString(effective)
      );
      lexer.removeErrorListeners();
      const ts = new CommonTokenStream(lexer);
      ts.fill();
      const parser = new ParserInterpreter(
        'PPL',
        grammar.vocabulary,
        grammar.parserRuleNames,
        grammar.parserATN,
        ts
      );
      parser.removeErrorListeners();
      let result: ReturnType<typeof buildCommandSuggestion>;
      parser.addErrorListener({
        syntaxError(recognizer: any, offendingSymbol: any, _l, _c, _m, e: any) {
          // Mirror production: every syntaxError runs buildCommandSuggestion;
          // keep the first that yields a suggestion (an earlier non-command
          // error must not lock the result out).
          if (!result) {
            result = buildCommandSuggestion(recognizer, offendingSymbol, e ?? null);
          }
        },
        reportAmbiguity() {},
        reportAttemptingFullContext() {},
        reportContextSensitivity() {},
      });
      try {
        parser.parse(startRule);
      } catch {
        // recovery path — listener already captured what it needed.
      }
      return result;
    }

    it('suggests "where" for a misspelled command (pipe-first) on the 101-command ATN', () => {
      // The real server grammar surfaces 101 command keywords here — the reason
      // the candidate cap is 150, not 60. A cap of 60 would suppress this.
      const s = firstSuggestion('| wherre balance > 1');
      expect(s?.code).toBe('UNKNOWN_COMMAND');
      expect(s?.fix.text).toBe('where');
    });

    it('catches the "fiedls" transposition (pipe-first)', () => {
      const s = firstSuggestion('| fiedls balance, age');
      expect(s?.fix.text).toBe('fields');
    });

    it('does not suggest for unrecognizable garbage', () => {
      expect(firstSuggestion('| zzzzzzzz')).toBeUndefined();
    });

    // Source-first regression coverage. On the server grammar a `source=... |
    // <typo>` mismatch unwinds the `(PIPE commands)*` closure back to `root`,
    // collapsing the follow-set to `{EOF}`. The PIPE-lookback fallback + the
    // ATN-derived FIRST(commands) candidate set is what recovers the suggestion
    // here; the primary follow-set path alone returns nothing. This is the gap
    // the pipe-first cases above could never have caught.
    it('suggests "where" for a source-first misspelled command', () => {
      const s = firstSuggestion('source=accounts | wherre balance > 1');
      expect(s?.code).toBe('UNKNOWN_COMMAND');
      expect(s?.fix.text).toBe('where');
    });

    it('catches a source-first transposition ("fiedls")', () => {
      const s = firstSuggestion('source=accounts | fiedls a, b');
      expect(s?.fix.text).toBe('fields');
    });

    it('recovers a typo on a later pipe ("head 5 | wherre")', () => {
      const s = firstSuggestion('source=accounts | head 5 | wherre a=1');
      expect(s?.fix.text).toBe('where');
    });

    it('stays silent on a valid source-first command (no false positive)', () => {
      expect(firstSuggestion('source=accounts | where balance > 1')).toBeUndefined();
    });

    it('stays silent on source-first garbage far from any command', () => {
      expect(firstSuggestion('source=accounts | zzzzzzzz')).toBeUndefined();
    });

    it('stays silent on a dangling source-first expression', () => {
      expect(firstSuggestion('source=accounts | where a >')).toBeUndefined();
    });
  });
});
