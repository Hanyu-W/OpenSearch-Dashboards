/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Option 2 — the prompt builder for the AI ("Ask Olly to fix") quick-fix.
 *
 * Pure and offline: it turns a broken query + its diagnostic into the freetext
 * `question` the `/api/enhancements/assist/generate` route forwards to the
 * agent, *after* applying two mandatory safety controls before anything
 * egresses to a possibly cross-account model (ARCC GenAI input-validation):
 *
 *   1. Literal redaction — predicate values in a PPL query can be PII
 *      (`where email='a@b.com'`, `where ssn=123456789`). We replace the *values*
 *      of quoted strings and bare numeric literals with placeholders so the
 *      model sees the query *shape* (which is what it needs to repair) without
 *      the sensitive values. Field and command names are preserved — they are
 *      what the fix operates on.
 *   2. Length cap — the route's `question` is an unbounded `schema.string()`;
 *      we cap the egressed text so a pathological query cannot send an unbounded
 *      payload to the model.
 *
 * The prompt instructs a MINIMAL repair that preserves intent, converting the
 * generic generate agent into a fix agent via prompt alone — no new ML-Commons
 * agent registration needed.
 */

/** Hard cap on the characters of query text that may egress to the model. */
export const MAX_QUERY_CHARS = 4096;

const REDACTED_STRING = "'<redacted>'";
const REDACTED_NUMBER = '<n>';

/**
 * Redact literal *values* from a PPL query while preserving its structure.
 *
 * - single- or double-quoted string literals → `'<redacted>'`
 * - standalone numeric literals → `<n>` (only when bounded by non-identifier
 *   chars, so a field like `field1` or `geo_point2` keeps its digits)
 *
 * Deliberately conservative: it never touches identifiers, command keywords, or
 * operators, so the redacted query is still recognizably the same shape.
 */
export function redactLiterals(query: string): string {
  // Quoted strings first (so digits inside a string aren't separately matched).
  let out = query.replace(/'(?:[^'\\]|\\.)*'/g, REDACTED_STRING);
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, REDACTED_STRING);
  // Bare numeric literals: a run of digits (with optional decimal/sign) that is
  // NOT part of an identifier. Lookbehind/ahead exclude identifier characters
  // and a dot, so `account_number`, `v2`, `1.2.3`-style tokens are left alone.
  out = out.replace(/(?<![A-Za-z0-9_.])[+-]?\d+(?:\.\d+)?(?![A-Za-z0-9_.])/g, REDACTED_NUMBER);
  return out;
}

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
 * Build the freetext `question` for the generate route. The query is redacted
 * and length-capped before it is embedded; the diagnostic message is included
 * verbatim (it is hard-coded English from the catalog, never user data).
 */
export function buildFixPrompt(query: string, diagnostic: FixPromptDiagnostic): string {
  const safeQuery = capLength(redactLiterals(query));
  return (
    `Fix this PPL query. A linter flagged: "${diagnostic.message}". ` +
    `Return ONLY the corrected PPL query, nothing else. ` +
    `Make the MINIMAL change that resolves the issue and preserves the original ` +
    `intent — keep the same commands in the same order and the same fields; do ` +
    `not add, drop, or reorder pipeline stages beyond what the fix requires. ` +
    `Literal values have been redacted as '<redacted>'/<n>; keep those ` +
    `placeholders in place. Original query: ${safeQuery}`
  );
}
