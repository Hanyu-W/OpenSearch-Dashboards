/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CompiledPPLLintAnalysis } from './lint/explain/attribution/snapshot';
import { LintResult } from './lint/diagnostic';
import { LintRunContext } from './lint/types';
import { toWorkerLintContextPayload } from './lint/worker_context';
import { PPLValidationResult } from './ppl_language_analyzer';
import { PPLWorkerProxyService } from './worker_proxy_service';

const service = new PPLWorkerProxyService();

export async function validateCompiledPPL(content: string): Promise<PPLValidationResult> {
  service.setup();
  return service.validate(content);
}

export async function lintCompiledPPL(
  content: string,
  context?: LintRunContext
): Promise<LintResult> {
  service.setup();
  return service.lint(content, toWorkerLintContextPayload(context));
}

export async function analyzeCompiledPPLLint(
  content: string,
  context?: LintRunContext
): Promise<CompiledPPLLintAnalysis> {
  service.setup();
  return service.analyzeLint(content, toWorkerLintContextPayload(context));
}

export async function validateCompiledPPLLintQueries(queries: string[]): Promise<boolean[]> {
  service.setup();
  return service.validateLintQueries(queries);
}

export function stopCompiledPPLWorker(): void {
  service.stop();
}
