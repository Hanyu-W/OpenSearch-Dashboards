/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LintResult, PPLLintContext, PPLLintBridgeRequest, LintRunContext } from '@osd/monaco';
// NOTE: these are deep imports into the built output rather than the '@osd/monaco'
// barrel on purpose. The barrel pulls in monaco-editor's browser ESM (incl. .css
// side-effect imports), which breaks bare Node resolution, and it is globally
// jest.mock()'d in tests (src/dev/jest/setup/monaco_mock.js) so its value exports
// are unavailable. Importing the leaf modules keeps the runtime lint engine
// usable on both the browser thread and under Jest.
import { runLint } from '@osd/monaco/target/ppl/lint/lint_runner';
import {
  createRuntimeRuleNameToIndex,
  RuleNameToIndex,
} from '@osd/monaco/target/ppl/lint/rule_index';
import { PIPE_FIRST_PREFIX, remapPipeFirstColumns } from '@osd/monaco/target/ppl/lint/range_utils';
import {
  hasExplainRules,
  runExplainLint,
} from '@osd/monaco/target/ppl/lint/explain/run_explain_lint';
import { resolveExplainRanges } from '@osd/monaco/target/ppl/lint/explain/resolve_explain_ranges';
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
  /**
   * The rule-name→index resolver for the grammar the tree was parsed with.
   * Handed to the explain range resolver so it can walk the same tree. Present
   * whenever `tree` is.
   */
  ruleNameToIndex: RuleNameToIndex | undefined;
}

function canAttemptExplain(context: PPLLintContext): boolean {
  return !!(
    context.isCalcite &&
    context.http &&
    hasExplainRules({
      overrides: context.overrides,
      dataSourceVersion: context.dataSourceVersion,
      isCalcite: context.isCalcite,
    })
  );
}

function lintWithGrammar(
  query: string,
  grammar: CachedGrammar,
  context: PPLLintContext | undefined
): GrammarLintOutcome {
  if (!query.trim()) {
    return { result: { diagnostics: [] }, tree: undefined, ruleNameToIndex: undefined };
  }

  const tree = buildRuntimeTree(query, grammar);
  if (!tree) {
    return { result: { diagnostics: [] }, tree: undefined, ruleNameToIndex: undefined };
  }

  const ruleNameToIndex = createRuntimeRuleNameToIndex(grammar.runtimeRuleNameToIndex);
  const diagnostics = runLint(tree, {
    ruleNameToIndex,
    dataSourceVersion: context?.dataSourceVersion,
    // Declare the surface so the field-slot shape pass fires here: on the
    // runtime bundle `grok field=body` is a silent misparse (no syntax error).
    // Cast to LintRunContext for type-compatibility so the spread no longer
    // needs an `any`: PPLLintContext carries a bridge-only `http`, but runLint
    // and its detectors are typed against LintRunContext and never read it (the
    // cast is compile-time only; `http` still rides along harmlessly at runtime).
    context: {
      ...(context as LintRunContext),
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
    ruleNameToIndex,
  };
}

/**
 * Layer the explain-backed rules on top of the static result. Best-effort: any
 * failure (no http client, no applicable rule, network error, non-Calcite plan)
 * leaves the static markers untouched. Runs only when the tree parsed cleanly,
 * the source is Calcite, an http client is present, and at least one explain
 * rule is enabled and applicable — so the `_explain` round-trip is skipped
 * whenever it could produce nothing.
 *
 * When a parse tree (and its rule index) is available, the explain diagnostics'
 * whole-query ranges are narrowed to the offending command via
 * `resolveExplainRanges` before merging. On the compiled-fallback path no tree
 * is threaded, so they keep their whole-query range — honest degradation.
 */
async function layerExplainLint(
  query: string,
  staticResult: LintResult,
  context: PPLLintContext,
  tree?: ParserRuleContext,
  ruleNameToIndex?: RuleNameToIndex
): Promise<LintResult> {
  const http = context.http;
  if (!http || !canAttemptExplain(context)) {
    return staticResult;
  }

  try {
    const plan = await explainCache.resolve(http, query, context.dataSourceId);
    if (!plan.isCalcite) {
      return staticResult;
    }
    let explainDiagnostics = runExplainLint(plan, {
      query,
      overrides: context.overrides,
      dataSourceVersion: context.dataSourceVersion,
      isCalcite: context.isCalcite,
    });
    if (explainDiagnostics.length === 0) {
      return staticResult;
    }
    // Narrow the whole-query ranges to the offending command when the parse tree
    // is in hand (the runtime-grammar path); no-op without a tree. `typeMap`
    // (field → esType) gates the divisive quick-fix to floating-point fields.
    if (tree && ruleNameToIndex) {
      explainDiagnostics = resolveExplainRanges(
        explainDiagnostics,
        tree,
        ruleNameToIndex,
        context.typeMap
      );
    }
    // Explain diagnostics were appended after the tree pass' own pipe-first
    // remap, so they never passed through it. Once ranges are precise this
    // matters: a pipe-first query would shift squiggles by the synthetic
    // `source=t ` prefix. Remap them here (harmless for a still-whole-query
    // range, which starts at column 0).
    const isPipeFirst = query.trimStart().startsWith('|');
    if (isPipeFirst) {
      explainDiagnostics = remapPipeFirstColumns(explainDiagnostics);
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

async function lintCompiledFallbackWithExplain(
  request: PPLLintBridgeRequest
): Promise<LintResult | null> {
  const { content, context, compiledFallbackLint, compiledFallbackValidate } = request;
  if (!content.trim()) {
    return { diagnostics: [] };
  }
  if (!context || !compiledFallbackLint) {
    return null;
  }

  const staticResult = await compiledFallbackLint(content);
  if (!compiledFallbackValidate || !canAttemptExplain(context)) {
    return staticResult;
  }

  try {
    const validation = await compiledFallbackValidate(content);
    if (!validation.isValid) {
      return staticResult;
    }
  } catch {
    return staticResult;
  }

  return layerExplainLint(content, staticResult, context);
}

/**
 * Main-thread lint bridge. Uses the runtime grammar when available; otherwise
 * delegates to the compiled worker fallback callbacks and, when the compiled
 * query validates cleanly, layers explain-backed rules on top. Returns null only
 * when it has no context/fallback it can use, allowing `resolvePPLLintResult`
 * to run the normal compiled fallback itself.
 */
export async function lintRuntimePPLQuery(
  request: PPLLintBridgeRequest
): Promise<LintResult | null> {
  const { content, context } = request;
  if (!context) {
    return null;
  }

  if (!context.useRuntimeGrammar) {
    return lintCompiledFallbackWithExplain(request);
  }

  const grammar = pplGrammarCache.getCachedGrammar(context.dataSourceId);
  if (!grammar) {
    return lintCompiledFallbackWithExplain(request);
  }

  const { result, tree, ruleNameToIndex } = lintWithGrammar(content, grammar, context);

  // The tree's presence is the clean-parse guard: skip explain on empty or
  // unparseable input so a half-typed query never triggers a round-trip. The
  // tree + rule index also let the explain layer narrow whole-query ranges to
  // the offending command.
  if (tree) {
    return layerExplainLint(content, result, context, tree, ruleNameToIndex);
  }
  return result;
}
