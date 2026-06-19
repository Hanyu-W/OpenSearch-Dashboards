/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  LintResult,
  PPLLintContext,
  PPLLintBridgeRequest,
  Diagnostic,
  DiagnosticRange,
} from '@osd/monaco';
// NOTE: these are deep imports into the built output rather than the '@osd/monaco'
// barrel on purpose. The barrel pulls in monaco-editor's browser ESM (incl. .css
// side-effect imports), which breaks bare Node resolution, and it is globally
// jest.mock()'d in tests (src/dev/jest/setup/monaco_mock.js) so its value exports
// are unavailable. Importing the leaf modules keeps the runtime lint engine
// usable on both the browser thread and under Jest.
import { runLint } from '@osd/monaco/target/ppl/lint/lint_runner';
import { createRuntimeRuleNameToIndex } from '@osd/monaco/target/ppl/lint/rule_index';
import {
  hasExplainRules,
  runExplainLint,
} from '@osd/monaco/target/ppl/lint/explain/run_explain_lint';
import {
  CharStream,
  CommonTokenStream,
  LexerInterpreter,
  ParserInterpreter,
  ParserRuleContext,
} from 'antlr4ng';
import { GeneralErrorListener } from '../shared/general_error_listerner';
import { CachedGrammar, pplGrammarCache } from './ppl_grammar_cache';
import { pickStartRuleIndex, resolveSpaceToken } from './runtime_grammar_utils';
import { explainCache } from '../../ppl_lint/explain_cache';

const PIPE_FIRST_PREFIX = 'source=t ';

/**
 * Subtract the synthetic pipe-first prefix length from line-one diagnostic
 * columns, clamped to a minimum of zero. Other lines are unchanged. Mirrors
 * `remapPipeFirstColumns` in the compiled path (ppl_language_analyzer.ts) so
 * runtime-grammar squiggles land on the same column as compiled ones — without
 * this, line-one diagnostics are offset by the prefix's 9 columns.
 */
function remapPipeFirstColumns(diagnostics: Diagnostic[]): Diagnostic[] {
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

function buildRuntimeTree(query: string, grammar: CachedGrammar): ParserRuleContext | undefined {
  const isPipeFirst = query.trimStart().startsWith('|');
  const effective = isPipeFirst ? PIPE_FIRST_PREFIX + query : query;

  const spaceToken = resolveSpaceToken(grammar);
  // With the synthetic prefix the effective query no longer starts with a pipe,
  // so use the standard start rule.
  const startRuleIndex = isPipeFirst
    ? grammar.startRuleIndex ?? 0
    : pickStartRuleIndex(query, grammar);
  const errorListener = new GeneralErrorListener(spaceToken);

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
  lexer.addErrorListener(errorListener);

  const tokenStream = new CommonTokenStream(lexer);
  tokenStream.fill();

  const parser = new ParserInterpreter(
    'PPL',
    grammar.vocabulary,
    grammar.parserRuleNames,
    grammar.parserATN,
    tokenStream
  );
  parser.removeErrorListeners();
  parser.addErrorListener(errorListener);
  // Unlike validation (buildParseTrees=false), the linter needs the tree.
  parser.buildParseTrees = true;

  try {
    const tree = parser.parse(startRuleIndex);
    // The error listener is the clean-parse precondition the explain layer
    // relies on (mirrors runtime_validation.ts): a half-typed query must not
    // reach the network. ANTLR recovers rather than throwing, so a non-null
    // tree comes back even for `source=accounts |`; treat any collected syntax
    // error as a failed parse.
    if (errorListener.errors.length > 0) {
      return undefined;
    }
    return tree ?? undefined;
  } catch {
    // parse() threw before producing a tree (e.g. an internal ATN error);
    // treat as unparseable. Normal ANTLR syntax errors are recovered above and
    // caught by the errorListener check.
    return undefined;
  }
}

/**
 * The static lint result paired with the parse tree it ran over. The tree is
 * `undefined` when the query is empty or failed to parse — both the empty-query
 * and parse-failure guard paths. The explain pass uses the tree's presence as
 * its clean-parse precondition: a half-typed query never reaches the network.
 */
interface GrammarLintOutcome {
  result: LintResult;
  tree: ParserRuleContext | undefined;
}

function lintWithGrammar(
  query: string,
  grammar: CachedGrammar,
  context: PPLLintContext | undefined
): GrammarLintOutcome {
  if (!query.trim()) {
    return { result: { diagnostics: [] }, tree: undefined };
  }

  const tree = buildRuntimeTree(query, grammar);
  if (!tree) {
    return { result: { diagnostics: [] }, tree: undefined };
  }

  const diagnostics = runLint(tree, {
    ruleNameToIndex: createRuntimeRuleNameToIndex(grammar.runtimeRuleNameToIndex),
    dataSourceVersion: context?.dataSourceVersion,
    // Declare the surface so the field-slot shape pass fires here: on the
    // runtime bundle `grok field=body` is a silent misparse (no syntax error).
    context: {
      ...(context as any),
      grammarSurface: 'runtime-bundle',
      grammarHash: grammar.grammarHash,
    },
  });

  // For a pipe-first query the tree was parsed with a synthetic `source=t `
  // prefix prepended (see buildRuntimeTree); subtract its width from line-one
  // columns so squiggles align with the user's text.
  const isPipeFirst = query.trimStart().startsWith('|');
  return {
    result: { diagnostics: isPipeFirst ? remapPipeFirstColumns(diagnostics) : diagnostics },
    tree,
  };
}

/**
 * Layer the explain-backed rules on top of the static result. Best-effort: any
 * failure (no http client, no applicable rule, network error, non-Calcite plan)
 * leaves the static markers untouched. Runs only when the tree parsed cleanly,
 * the source is Calcite, an http client is present, and at least one explain
 * rule is enabled and applicable — so the `_explain` round-trip is skipped
 * whenever it could produce nothing.
 */
async function layerExplainLint(
  query: string,
  staticResult: LintResult,
  context: PPLLintContext
): Promise<LintResult> {
  if (
    !context.isCalcite ||
    !context.http ||
    !hasExplainRules({
      overrides: context.overrides,
      dataSourceVersion: context.dataSourceVersion,
      isCalcite: context.isCalcite,
    })
  ) {
    return staticResult;
  }

  try {
    const plan = await explainCache.resolve(context.http, query, context.dataSourceId);
    if (!plan.isCalcite) {
      return staticResult;
    }
    const explainDiagnostics = runExplainLint(plan, {
      query,
      overrides: context.overrides,
      dataSourceVersion: context.dataSourceVersion,
      isCalcite: context.isCalcite,
    });
    if (explainDiagnostics.length === 0) {
      return staticResult;
    }
    return { diagnostics: [...staticResult.diagnostics, ...explainDiagnostics] };
  } catch (e) {
    // Keep the static markers only — explain rules are an enhancement. No live
    // throw path reaches here today (explainCache.resolve and runExplainLint are
    // each isolated), so this is defensive; warn for parity with lint_runner.
    // eslint-disable-next-line no-console
    console.warn('[ppl-lint] explain layering failed and was skipped', e);
    return staticResult;
  }
}

/**
 * Runtime-grammar lint bridge. Returns null when the runtime grammar is
 * disabled or not cached (the null triggers the compiled-grammar fallback).
 * Runs on the main thread, mirroring validateRuntimePPLQuery. Async because it
 * layers the explain-backed rules, which require a network round-trip; the
 * bridge contract and `resolvePPLLintResult` already await the result, so this
 * is a non-breaking change for callers.
 */
export async function lintRuntimePPLQuery(
  request: PPLLintBridgeRequest
): Promise<LintResult | null> {
  const { content, context } = request;
  if (!context?.useRuntimeGrammar) {
    return null;
  }

  const grammar = pplGrammarCache.getCachedGrammar(context.dataSourceId);
  if (!grammar) {
    return null;
  }

  const { result, tree } = lintWithGrammar(content, grammar, context);

  // The tree's presence is the clean-parse guard: skip explain on empty or
  // unparseable input so a half-typed query never triggers a round-trip.
  if (tree) {
    return layerExplainLint(content, result, context);
  }
  return result;
}
