/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Monaco command registration for the AI ("Ask AI to fix") quick-fix. The
 * command stays inside the leaf Monaco package, but it no longer performs a
 * hidden LLM round trip or applies editor edits. It builds a plain request and
 * asks the host to open AI chat; the host owns chat services and the
 * confirmation/apply tool.
 */

import { monaco } from '../../../monaco';
import { AskPPLLintFixRequest, getPPLLintContext, PPLLintContext } from '../../lint_bridge';
import { LintRunContext } from '../types';
import { AI_FIX_COMMAND_ID, AiFixCommandArgs } from './ai_fix_command_id';
import {
  buildChatFixMessage,
  buildChatFixContext,
  DEFAULT_PPL_LINT_FIX_TOOL_NAME,
  hashPPLLintFixSource,
} from './build_chat_fix_message';
import { emitPPLLintTelemetry, PPL_LINT_TELEMETRY_EVENTS, ruleLabel } from '../telemetry';

export { AI_FIX_COMMAND_ID, AiFixCommandArgs };

function findModel(modelUri: string): monaco.editor.ITextModel | undefined {
  return monaco.editor.getModels().find((m) => m.uri.toString() === modelUri);
}

function buildLintRunContext(ctx?: PPLLintContext): LintRunContext | undefined {
  return (
    ctx && {
      fields: ctx.fields,
      typeMap: ctx.typeMap,
      disabledObjectFields: ctx.disabledObjectFields,
      visibleIndices: ctx.visibleIndices,
      isCalcite: ctx.isCalcite,
      overrides: ctx.overrides,
      dataSourceId: ctx.dataSourceId,
      dataSourceVersion: ctx.dataSourceVersion,
      settings: ctx.settings,
    }
  );
}

function createRequestId(): string {
  return `ppl-lint-fix-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build and dispatch the chat request. Exported for unit testing; the
 * registration below wraps it. Returns the request when it was sent.
 */
export function handleAiFixCommand(
  args: AiFixCommandArgs,
  context: {
    datasetTitle?: string;
    dataSourceId?: string;
    enableAIFeatures?: boolean;
    onAskAiFix?: (request: AskPPLLintFixRequest) => void;
    aiFixToolName?: string;
  },
  query: string,
  lintContext?: LintRunContext,
  deps?: {
    createRequestId?: () => string;
  }
): AskPPLLintFixRequest | undefined {
  if (context.enableAIFeatures === false || !context.onAskAiFix) {
    return undefined;
  }
  const diagnostic = {
    message: args.message,
    ruleId: args.ruleId,
    ...(args.operation ? { operation: args.operation } : {}),
    ...(args.outcome ? { outcome: args.outcome } : {}),
    ...(args.targetText ? { targetText: args.targetText } : {}),
    ...(args.targetRange ? { targetRange: args.targetRange } : {}),
    ...(args.relatedTexts?.length ? { relatedTexts: args.relatedTexts } : {}),
  };
  const requestWithoutMessage = {
    requestId: deps?.createRequestId?.() ?? createRequestId(),
    sourceQueryHash: hashPPLLintFixSource(query),
    toolName: context.aiFixToolName || DEFAULT_PPL_LINT_FIX_TOOL_NAME,
    modelUri: args.modelUri,
    query,
    diagnostic,
    datasetTitle: context.datasetTitle,
    dataSourceId: context.dataSourceId,
  };
  const request: AskPPLLintFixRequest = {
    ...requestWithoutMessage,
    chatMessage: buildChatFixMessage(requestWithoutMessage),
    chatContext: buildChatFixContext(requestWithoutMessage),
    lintContext,
  };
  context.onAskAiFix(request);
  // Feature-usage telemetry: emitted after the dispatch so the event means "an
  // AI fix was actually requested" (the chat opened), not merely "the action was
  // clicked" — the guard above returns early when AI features are off or no
  // opener is wired. `rule` is sentinel-mapped (never undefined so the field
  // survives JSON serialization), and `marker` carries the per-finding
  // correlation id set by the code-action provider so this click joins the
  // matching `ai_fix_offered`. No-ops until the host registers a sink.
  emitPPLLintTelemetry({
    name: PPL_LINT_TELEMETRY_EVENTS.AI_FIX_CLICKED,
    data: { rule: ruleLabel(args.ruleId), marker: args.markerId },
  });
  return request;
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
      const lintContext = buildLintRunContext(ctx);
      handleAiFixCommand(
        rawArgs,
        {
          datasetTitle: ctx?.datasetTitle,
          dataSourceId: ctx?.dataSourceId,
          enableAIFeatures: ctx?.enableAIFeatures,
          onAskAiFix: ctx?.onAskAiFix,
          aiFixToolName: ctx?.aiFixToolName,
        },
        model.getValue(),
        lintContext
      );
    }
  );
}
