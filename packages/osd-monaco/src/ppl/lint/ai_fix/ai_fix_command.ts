/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Option 2 — Monaco command registration for the AI ("Ask Olly to fix")
 * quick-fix. The code-action provider emits a CodeAction carrying this command
 * id; Monaco dispatches it when the user clicks the lightbulb. The handler does
 * the async LLM round-trip *after* the click (so the lightbulb is instant),
 * re-validates the untrusted result, and applies it as editor text.
 *
 * Everything the handler needs is read from the per-model lint context via
 * `getPPLLintContext(model)` — `http` (already OSD's HttpSetup), `datasetTitle`,
 * `dataSourceId`, `enableAIFeatures`. No cross-plugin import, no React, no new
 * bridge: the command lives in the same package as `code_action_provider.ts`
 * and `lint_bridge.ts`.
 */

import * as antlr from 'antlr4ng';
import { SimplifiedOpenSearchPPLLexer, SimplifiedOpenSearchPPLParser } from '@osd/antlr-grammar';
import { monaco } from '../../../monaco';
import { getPPLLintContext } from '../../lint_bridge';
import { runAiFix, AiFixHttpClient, RunAiFixDeps } from './run_ai_fix';
import { CandidateLintFacts } from './validate_candidate_fix';
import { getPPLLanguageAnalyzer } from '../../ppl_language_analyzer';
import { buildPipelineShape } from '../pipeline_shape';
import { createCompiledRuleNameToIndex } from '../rule_index';
import { AI_FIX_COMMAND_ID } from './ai_fix_command_id';

export { AI_FIX_COMMAND_ID };

/**
 * Route paths the handler POSTs to. Kept as constants here (not imported from
 * query_enhancements) so `@osd/monaco` stays a leaf package. They mirror
 * `API.QUERY_ASSIST` in query_enhancements/common/constants.ts.
 */
const ASSIST_LANGUAGES_PATH = '/api/enhancements/assist/languages';
const ASSIST_GENERATE_PATH = '/api/enhancements/assist/generate';

/** The argument shape the code-action provider passes to the command. */
export interface AiFixCommandArgs {
  modelUri: string;
  ruleId?: string;
  message: string;
}

/** Lint a query on the compiled surface for re-validation (parse-clean + rule ids). */
function compiledLintFacts(query: string): CandidateLintFacts {
  const validation = getPPLLanguageAnalyzer().validate(query);
  const result = getPPLLanguageAnalyzer().lint(query);
  return {
    ruleIds: result.diagnostics.map((d) => d.ruleId),
    syntaxClean: validation.isValid,
  };
}

/** The ordered pipeline command names of a query, for intent (shape) preservation. */
function compiledPipelineShape(query: string): string[] {
  try {
    const cs = antlr.CharStream.fromString(query);
    const lx = new SimplifiedOpenSearchPPLLexer(cs);
    const ts = new antlr.CommonTokenStream(lx);
    const parser = new SimplifiedOpenSearchPPLParser(ts);
    parser.removeErrorListeners();
    const tree = parser.root();
    return buildPipelineShape(tree, createCompiledRuleNameToIndex()).stages.map((s) => s.command);
  } catch {
    return [];
  }
}

function findModel(modelUri: string): monaco.editor.ITextModel | undefined {
  return monaco.editor.getModels().find((m) => m.uri.toString() === modelUri);
}

/** Replace the whole document with the fixed query (undo-aware; never auto-runs). */
function applyFix(model: monaco.editor.ITextModel, fixedQuery: string): void {
  const fullRange = model.getFullModelRange();
  model.pushEditOperations(null, [{ range: fullRange, text: fixedQuery }], () => null);
}

/**
 * The command handler. Exported for unit testing (with a stub model + http); the
 * registration below wraps it. Returns the outcome so tests/telemetry can
 * observe applied / skipped / rejected / error.
 */
export async function handleAiFixCommand(
  args: AiFixCommandArgs,
  http: AiFixHttpClient | undefined,
  context: {
    datasetTitle?: string;
    dataSourceId?: string;
    enableAIFeatures?: boolean;
  },
  apply: (fixedQuery: string) => void,
  query: string,
  deps?: Partial<RunAiFixDeps>
): Promise<ReturnType<typeof runAiFix> extends Promise<infer R> ? R : never> {
  if (!http) {
    return { status: 'error', message: 'no http client on lint context' };
  }
  const fullDeps: RunAiFixDeps = {
    http,
    languagesPath: ASSIST_LANGUAGES_PATH,
    generatePath: ASSIST_GENERATE_PATH,
    lint: deps?.lint ?? compiledLintFacts,
    pipelineShape: deps?.pipelineShape ?? compiledPipelineShape,
  };
  const outcome = await runAiFix(
    {
      query,
      diagnostic: { message: args.message, ruleId: args.ruleId ?? '' },
      datasetTitle: context.datasetTitle,
      dataSourceId: context.dataSourceId,
      enableAIFeatures: context.enableAIFeatures,
    },
    fullDeps
  );
  if (outcome.status === 'applied') {
    apply(outcome.fixedQuery);
  }
  return outcome;
}

/**
 * Register the AI quick-fix command with Monaco. Idempotent-friendly: callers
 * should register once (alongside registerPPLLanguage). Returns the disposable.
 */
export function registerAiFixCommand(): monaco.IDisposable {
  return monaco.editor.registerCommand(
    AI_FIX_COMMAND_ID,
    // The accessor is unused; the args carry everything the handler needs.
    (_accessor: unknown, rawArgs: AiFixCommandArgs) => {
      const model = rawArgs && findModel(rawArgs.modelUri);
      if (!model) {
        return;
      }
      const ctx = getPPLLintContext(model);
      // Fire-and-forget: the handler awaits the round-trip and applies on accept.
      void handleAiFixCommand(
        rawArgs,
        ctx?.http,
        {
          datasetTitle: ctx?.datasetTitle,
          dataSourceId: ctx?.dataSourceId,
          enableAIFeatures: ctx?.enableAIFeatures,
        },
        (fixedQuery) => applyFix(model, fixedQuery),
        model.getValue()
      ).catch(() => {
        // AI fix is best-effort: never disrupt the editor on failure.
      });
    }
  );
}
