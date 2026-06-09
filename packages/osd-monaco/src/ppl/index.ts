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
  isPPLLintEnabled,
  registerPPLLintProvider,
  resolvePPLLintResult,
  setPPLLintContext,
  setPPLLintEnabled,
} from './lint_provider';
export type { PPLLintContext, PPLLintProvider, PPLLintProviderRequest } from './lint_provider';
export type { Diagnostic, DiagnosticRange, LintResult, LintSeverity } from './lint/diagnostic';
export type { CatalogEntry, LintRunContext } from './lint/types';
export { runLint } from './lint/lint_runner';
export { createRuntimeRuleNameToIndex } from './lint/rule_index';

export const PPLLang = { ID };
