/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Both values and types come from the Monaco-free `@osd/monaco/ppl-lint`
// subpath (a redirect-stub dir). It exposes only the engine, so it neither
// pulls in Monaco ESM (which is jest.mock()'d in tests) nor couples this file
// to the `@osd/monaco/target/...` build layout.
import type { LintResult, LintRunContext } from '@osd/monaco/ppl-lint';
import { pplGrammarCache } from './ppl_grammar_cache';
// The parse-and-lint core lives in the Node-safe `headless_ppl_lint` module so
// the browser fallback and the SQL CI validation runner share one
// implementation (no divergent copy that could drift the parse tree). This file
// only adds the browser-specific bits: the `useRuntimeGrammar` gate and the
// singleton `pplGrammarCache` lookup.
import { lintWithGrammar } from './headless_ppl_lint';

/**
 * The lint context this runtime fallback reads. Mirrors `@osd/monaco`'s
 * PPLLintContext minus the Monaco-only pieces (e.g. the http client), so this
 * file needs nothing from the Monaco-laden `@osd/monaco` barrel.
 */
type RuntimeLintContext = LintRunContext & { useRuntimeGrammar?: boolean };

/**
 * The subset of `@osd/monaco`'s PPLLintBridgeRequest this fallback consumes.
 * The full bridge request also carries a `monaco.editor.IModel`, which this
 * runtime path never reads — so we narrow to a Monaco-free shape.
 */
interface RuntimeLintRequest {
  content: string;
  context?: RuntimeLintContext;
}

/** Returns null when runtime grammar is unavailable, triggering the compiled fallback. */
export async function lintRuntimePPLQuery(request: RuntimeLintRequest): Promise<LintResult | null> {
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
