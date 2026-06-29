/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Option 2 — the AI quick-fix orchestration, factored out of the Monaco command
 * handler so it is unit-testable with a mock HTTP client (the only path
 * checkable without a live ML-Commons cluster).
 *
 * Flow (all client-side; nothing is auto-run):
 *   1. preconditions — AI features on, an index (datasetTitle) is known;
 *   2. agent probe   — GET assist/languages must list PPL (graceful no-op when
 *      no agent is configured: the local SQL cluster has no ML-Commons);
 *   3. generate      — POST the length-capped fix prompt (the query is sent
 *      verbatim, gated on the same ENABLE_AI_FEATURES consent as Query-Assist;
 *      see build_fix_prompt for the egress posture);
 *   4. re-validate   — parse-clean + diagnostic cleared + no new diagnostic +
 *      pipeline-shape preserved + token overlap, all against the raw original so
 *      the prompt and the validator agree (see validate_candidate_fix);
 *   5. return the accepted text for the caller to apply via pushEditOperations.
 *
 * The agent's output is untrusted (ARCC AIQi): it is only ever returned as a
 * whole PPL string the user explicitly accepts, never interpolated into another
 * call, and applied as editor text — never executed.
 */

import { PPLLintHttpClient } from '../../lint_bridge';
import { buildFixPrompt } from './build_fix_prompt';
import {
  validateCandidateFix,
  ValidateCandidateDeps,
  ValidateCandidateResult,
} from './validate_candidate_fix';

/**
 * HTTP surface for the AI fix. An alias of the bridge's {@link PPLLintHttpClient}
 * (whose `get` is optional and `post` required) rather than a parallel shape — it
 * is exactly what `getPPLLintContext(model).http` returns and is satisfied by
 * core's `HttpSetup`. A client without `get` is treated as "no agent reachable"
 * (the probe returns false), so the AI fix degrades gracefully.
 */
export type AiFixHttpClient = PPLLintHttpClient;

export interface RunAiFixRequest {
  /** The full query text to repair. */
  query: string;
  /** The flagged diagnostic. */
  diagnostic: { message: string; ruleId: string };
  /** Index the generate route needs (from dataset title). */
  datasetTitle?: string;
  /** Multi-data-source id, forwarded to the route. */
  dataSourceId?: string;
  /** The global ENABLE_AI_FEATURES uiSetting value. */
  enableAIFeatures?: boolean;
}

export interface RunAiFixDeps extends ValidateCandidateDeps {
  http: AiFixHttpClient;
  /** Route paths (injected so the leaf package needn't import query_enhancements). */
  languagesPath: string;
  generatePath: string;
}

export type RunAiFixOutcome =
  | { status: 'applied'; fixedQuery: string }
  | { status: 'skipped'; reason: 'ai-disabled' | 'no-index' | 'no-agent' }
  | { status: 'rejected'; validation: ValidateCandidateResult }
  | { status: 'error'; message: string };

const LANGUAGE = 'PPL';

/** Probe whether a PPL generation agent is configured on the data source. */
async function pplAgentAvailable(deps: RunAiFixDeps, dataSourceId?: string): Promise<boolean> {
  if (!deps.http.get) {
    return false;
  }
  try {
    const res = (await deps.http.get(deps.languagesPath, {
      query: { dataSourceId },
    })) as { configuredLanguages?: string[] } | undefined;
    const langs = res?.configuredLanguages;
    return Array.isArray(langs) && langs.includes(LANGUAGE);
  } catch {
    return false;
  }
}

export async function runAiFix(
  request: RunAiFixRequest,
  deps: RunAiFixDeps
): Promise<RunAiFixOutcome> {
  // 1. preconditions
  if (request.enableAIFeatures === false) {
    return { status: 'skipped', reason: 'ai-disabled' };
  }
  if (!request.datasetTitle) {
    return { status: 'skipped', reason: 'no-index' };
  }

  // 2. agent probe — degrade gracefully when no agent is configured
  if (!(await pplAgentAvailable(deps, request.dataSourceId))) {
    return { status: 'skipped', reason: 'no-agent' };
  }

  // 3. generate
  let candidate: string;
  try {
    const body = JSON.stringify({
      index: request.datasetTitle,
      language: LANGUAGE,
      question: buildFixPrompt(request.query, request.diagnostic),
      dataSourceId: request.dataSourceId,
    });
    const res = (await deps.http.post(deps.generatePath, { body })) as
      | { query?: string }
      | undefined;
    if (!res || typeof res.query !== 'string') {
      return { status: 'error', message: 'generate route returned no query' };
    }
    candidate = res.query;
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }

  // 4. re-validate the untrusted candidate
  const validation = validateCandidateFix(
    request.query,
    candidate,
    request.diagnostic.ruleId,
    deps
  );
  if (!validation.accepted) {
    return { status: 'rejected', validation };
  }

  // 5. accepted — caller applies via pushEditOperations (text only, never runs)
  return { status: 'applied', fixedQuery: candidate.trim() };
}
