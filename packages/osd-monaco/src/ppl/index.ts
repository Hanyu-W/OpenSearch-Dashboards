/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This import registers the PPL monaco language contribution
 */
import './language';
export { revalidatePPLModel } from './language';
import { ID } from './constants';
export {
  clearPPLValidationContext,
  registerPPLValidationProvider,
  resolvePPLValidationResult,
  setPPLValidationContext,
} from './validation_provider';
export type {
  PPLValidationContext,
  PPLValidationProvider,
  PPLValidationProviderRequest,
} from './validation_provider';
export type { PPLValidationResult } from './ppl_language_analyzer';

export {
  clearPPLLintContext,
  getPPLLintContext,
  isPPLLintEnabled,
  registerPPLLintBridge,
  resolvePPLLintResult,
  setPPLLintContext,
  setPPLLintEnabled,
} from './lint_bridge';
export type {
  AskPPLLintFixRequest,
  PPLLintContext,
  PPLLintBridge,
  PPLLintBridgeRequest,
  PPLLintHttpClient,
} from './lint_bridge';
export {
  DEFAULT_PPL_LINT_FIX_TOOL_NAME,
  hashPPLLintFixSource,
  buildChatFixMessage,
  buildChatFixContext,
} from './lint/ai_fix/build_chat_fix_message';
export {
  validatePPLLintFixCandidate,
  compiledLintFacts,
  compiledPipelineShape,
} from './lint/ai_fix/validate_candidate_fix';
export type { ValidateCandidateResult } from './lint/ai_fix/validate_candidate_fix';
export { buildCommandSuggestion } from './command_suggestion';
export type { CommandSuggestion } from './command_suggestion';
export type { Diagnostic, DiagnosticRange, LintResult, LintSeverity } from './lint/diagnostic';
export type { BundleRuleOverrides, CatalogEntry, LintRunContext } from './lint/types';
export { runLint } from './lint/lint_runner';
export { getBundledCatalog } from './lint/catalog';
export { createRuntimeRuleNameToIndex } from './lint/rule_index';
export { runExplainLint, hasExplainRules } from './lint/explain/run_explain_lint';
export type {
  ExplainPlan,
  ExplainRelNode,
  ExplainRelTree,
  ExplainDetector,
  ExplainLintContext,
} from './lint/explain/explain_types';

export const PPLLang = { ID };
