/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LintResult, PPLLintContext, PPLLintProviderRequest } from '@osd/monaco';
// NOTE: these are deep imports into the built output rather than the '@osd/monaco'
// barrel on purpose. The barrel pulls in monaco-editor's browser ESM (incl. .css
// side-effect imports), which breaks bare Node resolution, and it is globally
// jest.mock()'d in tests (src/dev/jest/setup/monaco_mock.js) so its value exports
// are unavailable. Importing the leaf modules keeps the runtime lint engine
// usable on both the browser thread and under Jest.
import { runLint } from '@osd/monaco/target/ppl/lint/lint_runner';
import { createRuntimeRuleNameToIndex } from '@osd/monaco/target/ppl/lint/rule_index';
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

const PIPE_FIRST_PREFIX = 'source=t ';

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
    return tree ?? undefined;
  } catch {
    // Even on a parse exception, the error-recovery tree may be available.
    return undefined;
  }
}

function lintWithGrammar(
  query: string,
  grammar: CachedGrammar,
  context: PPLLintContext | undefined
): LintResult {
  if (!query.trim()) {
    return { diagnostics: [] };
  }

  const tree = buildRuntimeTree(query, grammar);
  if (!tree) {
    return { diagnostics: [] };
  }

  const diagnostics = runLint(tree, {
    ruleNameToIndex: createRuntimeRuleNameToIndex(grammar.runtimeRuleNameToIndex),
    dataSourceVersion: context?.dataSourceVersion,
    context: context as any,
  });

  return { diagnostics };
}

/**
 * Runtime-grammar lint provider. Returns null when the runtime grammar is
 * disabled or not cached (the null triggers the compiled-grammar fallback).
 * Runs on the main thread, mirroring validateRuntimePPLQuery.
 */
export function lintRuntimePPLQuery(request: PPLLintProviderRequest): LintResult | null {
  const { content, context } = request;
  if (!context?.useRuntimeGrammar) {
    return null;
  }

  const grammar = pplGrammarCache.getCachedGrammar(context.dataSourceId);
  if (!grammar) {
    return null;
  }

  return lintWithGrammar(content, grammar, context);
}
