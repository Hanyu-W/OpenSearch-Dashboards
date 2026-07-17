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
import { createRuntimeRuleNameToIndex } from '@osd/monaco/target/ppl/lint/rule_index';
import { PIPE_FIRST_PREFIX, remapPipeFirstColumns } from '@osd/monaco/target/ppl/lint/range_utils';
import {
  hasExplainRules,
  runExplainLint,
} from '@osd/monaco/target/ppl/lint/explain/run_explain_lint';
import { buildExplainAttributionSnapshot } from '@osd/monaco/target/ppl/lint/explain/attribution/candidates';
import { validateExplainAttributionSnapshot } from '@osd/monaco/target/ppl/lint/explain/attribution/snapshot';
import type { ExplainAttributionSnapshot } from '@osd/monaco/target/ppl/lint/explain/attribution/snapshot';
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
import {
  createExplainAttributionState,
  runExplainIsolation,
} from '../../ppl_lint/explain_attribution';

export interface RuntimeParseOutcome {
  tree: ParserRuleContext;
  parserSource: string;
  parserPrefixLength: number;
}

export function buildRuntimeTree(
  query: string,
  grammar: CachedGrammar
): RuntimeParseOutcome | undefined {
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
    return tree
      ? {
          tree,
          parserSource: effective,
          parserPrefixLength: isPipeFirst ? PIPE_FIRST_PREFIX.length : 0,
        }
      : undefined;
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
  parse: RuntimeParseOutcome | undefined;
  snapshot: ExplainAttributionSnapshot | undefined;
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
    return { result: { diagnostics: [] }, parse: undefined, snapshot: undefined };
  }

  const parse = buildRuntimeTree(query, grammar);
  if (!parse) {
    return { result: { diagnostics: [] }, parse: undefined, snapshot: undefined };
  }

  const ruleNameToIndex = createRuntimeRuleNameToIndex(grammar.runtimeRuleNameToIndex);
  const diagnostics = runLint(parse.tree, {
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
    parse,
    snapshot:
      context && canAttemptExplain(context)
        ? buildExplainAttributionSnapshot(parse.tree, ruleNameToIndex, parse.parserSource, {
            parserPrefixLength: parse.parserPrefixLength,
            typeMap: context.typeMap,
          })
        : undefined,
  };
}

function isRequestCurrent(
  request: PPLLintBridgeRequest,
  capturedVersion: number | undefined
): boolean {
  const model = request.model;
  if (typeof model.isDisposed === 'function' && model.isDisposed()) {
    return false;
  }
  if (typeof model.getValue === 'function' && model.getValue() !== request.content) {
    return false;
  }
  return (
    capturedVersion === undefined ||
    typeof model.getVersionId !== 'function' ||
    model.getVersionId() === capturedVersion
  );
}

/**
 * Layer the explain-backed rules on top of the static result. Best-effort: any
 * failure (no http client, no applicable rule, network error, non-Calcite plan)
 * leaves the static markers untouched. Runs only when the tree parsed cleanly,
 * the source is Calcite, an http client is present, and at least one explain
 * rule is enabled and applicable — so the `_explain` round-trip is skipped
 * whenever it could produce nothing.
 *
 * The runtime parse tree is the source authority. Ambiguous findings remain
 * suppressed until bounded control/treatment probes identify exact candidates.
 */
async function layerExplainLint(
  query: string,
  staticResult: LintResult,
  context: PPLLintContext,
  snapshot: ExplainAttributionSnapshot,
  validateGeneratedQueries: (queries: string[]) => Promise<boolean[]>,
  request: PPLLintBridgeRequest,
  capturedVersion?: number
): Promise<LintResult> {
  const http = context.http;
  if (!http || !canAttemptExplain(context)) {
    return staticResult;
  }
  const hasSupportedCandidate = snapshot.candidates.some(
    ({ operation }) => !snapshot.unsupportedOperations.includes(operation)
  );
  if (!hasSupportedCandidate) {
    return staticResult;
  }

  try {
    const resolution = await explainCache.resolveResult(http, query, context.dataSourceId);
    if (resolution.status !== 'ok' || !isRequestCurrent(request, capturedVersion)) {
      return staticResult;
    }
    const explainDiagnostics = runExplainLint(resolution.plan, {
      query,
      overrides: context.overrides,
      dataSourceVersion: context.dataSourceVersion,
      isCalcite: context.isCalcite,
    });
    if (explainDiagnostics.length === 0) {
      return staticResult;
    }

    const attributionInputs = {
      query,
      snapshot,
      typeMap: context.typeMap,
      baselineDiagnostics: explainDiagnostics,
      http,
      dataSourceId: context.dataSourceId,
      validateGeneratedQueries,
      isCurrent: () => isRequestCurrent(request, capturedVersion),
    };
    const attributionState = createExplainAttributionState(attributionInputs);
    const baselineResult = {
      diagnostics: [...staticResult.diagnostics, ...attributionState.immediateDiagnostics],
    };
    request.publishResult?.(baselineResult);

    if (!attributionState.needsIsolation) {
      return baselineResult;
    }

    if (!isRequestCurrent(request, capturedVersion)) {
      return baselineResult;
    }
    const isolated = await runExplainIsolation(attributionInputs, attributionState);
    return { diagnostics: [...staticResult.diagnostics, ...isolated] };
  } catch (e) {
    // Keep the static markers only — explain rules are an enhancement. No live
    // throw path reaches here today (explainCache.resolveResult and runExplainLint are
    // each isolated), so this is defensive; warn for parity with lint_runner.
    // eslint-disable-next-line no-console
    console.warn('[ppl-lint] explain layering failed and was skipped', e);
    return staticResult;
  }
}

async function lintCompiledFallbackWithExplain(
  request: PPLLintBridgeRequest,
  capturedVersion?: number
): Promise<LintResult | null> {
  const {
    content,
    context,
    compiledFallbackLint,
    compiledFallbackAnalyze,
    compiledFallbackValidateProbes,
  } = request;
  if (!content.trim()) {
    return { diagnostics: [] };
  }
  if (!context || !compiledFallbackLint) {
    return null;
  }

  if (!compiledFallbackAnalyze || !canAttemptExplain(context)) {
    const staticResult = await compiledFallbackLint(content);
    request.publishResult?.(staticResult);
    return staticResult;
  }

  let analysis;
  try {
    analysis = await compiledFallbackAnalyze(content);
  } catch {
    const staticResult = await compiledFallbackLint(content);
    request.publishResult?.(staticResult);
    return staticResult;
  }
  const staticResult = analysis.result;
  request.publishResult?.(staticResult);
  if (!isRequestCurrent(request, capturedVersion)) {
    return staticResult;
  }
  const snapshot = validateExplainAttributionSnapshot(analysis.attribution, content);
  if (!snapshot) {
    return staticResult;
  }
  return layerExplainLint(
    content,
    staticResult,
    context,
    snapshot,
    compiledFallbackValidateProbes ??
      (async () => {
        throw new Error('compiled probe validation unavailable');
      }),
    request,
    capturedVersion
  );
}

async function lintCompiledStaticOnly(request: PPLLintBridgeRequest): Promise<LintResult | null> {
  const { content, context, compiledFallbackLint } = request;
  if (!content.trim()) {
    return { diagnostics: [] };
  }
  if (!context || !compiledFallbackLint) {
    return null;
  }
  const result = await compiledFallbackLint(content);
  request.publishResult?.(result);
  return result;
}

/**
 * Main-thread lint bridge. Uses the runtime grammar when available; otherwise
 * delegates to the compiled worker fallback callbacks. Returns null only when
 * it has no context/fallback it can use, allowing `resolvePPLLintResult` to run
 * the normal compiled fallback itself.
 */
export async function lintRuntimePPLQuery(
  request: PPLLintBridgeRequest
): Promise<LintResult | null> {
  const { content, context } = request;
  const capturedVersion =
    typeof request.model.getVersionId === 'function' ? request.model.getVersionId() : undefined;
  if (!context) {
    return null;
  }

  if (!context.useRuntimeGrammar) {
    return lintCompiledFallbackWithExplain(request, capturedVersion);
  }

  const grammar = pplGrammarCache.getCachedGrammar(context.dataSourceId);
  if (!grammar) {
    return lintCompiledStaticOnly(request);
  }

  const { result, parse, snapshot } = lintWithGrammar(content, grammar, context);
  request.publishResult?.(result);

  // The tree's presence is the clean-parse guard: skip explain on empty or
  // unparseable input so a half-typed query never triggers a round-trip. The
  // tree + rule index also let the explain layer narrow whole-query ranges to
  // the offending command.
  if (parse && snapshot) {
    return layerExplainLint(
      content,
      result,
      context,
      snapshot,
      async (queries) => queries.map((query) => !!buildRuntimeTree(query, grammar)),
      request,
      capturedVersion
    );
  }
  return result;
}
