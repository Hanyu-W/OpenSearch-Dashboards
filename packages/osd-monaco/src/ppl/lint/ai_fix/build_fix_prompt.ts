/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Option 2 — the prompt builder for the AI ("Ask AI to fix") quick-fix.
 *
 * Pure and offline: it turns a broken query + its diagnostic into the freetext
 * `question` the `/api/enhancements/assist/generate` route forwards to the
 * agent.
 *
 * Egress posture: the query is sent verbatim (no client-side redaction), which
 * matches the existing Query-Assist surface — the user's natural-language
 * question is forwarded to the same generate route and the same agent under the
 * same `ENABLE_AI_FEATURES` consent. Sending the real query (including predicate
 * literal values) is what lets the agent return a directly-applicable fix and
 * keeps re-validation coherent (it lints the raw candidate against the raw
 * original; see `run_ai_fix`/`validate_candidate_fix`). Per ARCC GenAI input
 * guidance, sensitive-data protection for this egress is the operator's
 * responsibility via the agent's own guardrails/PII filters — the OSD client
 * cannot enforce them, and a prior best-effort literal redactor was removed
 * because it made the prompt (placeholder-bearing) and the validator
 * (raw-original) disagree, so a legitimate fix could never apply.
 *
 * The one client-side control kept is a length cap: the route's `question` is an
 * unbounded `schema.string()`, so we bound the egressed text. The prompt
 * instructs a MINIMAL repair that preserves intent, converting the generic
 * generate agent into a fix agent via prompt alone — no new ML-Commons agent
 * registration needed.
 */

/** Hard cap on the characters of query text that may egress to the model. */
export const MAX_QUERY_CHARS = 4096;

/** Truncate to the egress cap, marking the cut so the model knows it's partial. */
export function capLength(text: string, max: number = MAX_QUERY_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}… [truncated]`;
}

export interface FixPromptDiagnostic {
  message: string;
  ruleId?: string;
}

/**
 * Build the freetext `question` for the generate route. The query is
 * length-capped before it is embedded; the diagnostic message is included so the
 * model knows which rule was violated and on which field/value.
 */
export function buildFixPrompt(query: string, diagnostic: FixPromptDiagnostic): string {
  const safeQuery = capLength(query);
  return (
    `Fix this PPL query. A linter flagged: "${diagnostic.message}". ` +
    `Return ONLY the corrected PPL query, nothing else. ` +
    `Make the MINIMAL change that resolves the issue and preserves the original ` +
    `intent — keep the same commands in the same order and the same fields; do ` +
    `not add, drop, or reorder pipeline stages beyond what the fix requires. ` +
    `Original query: ${safeQuery}`
  );
}
