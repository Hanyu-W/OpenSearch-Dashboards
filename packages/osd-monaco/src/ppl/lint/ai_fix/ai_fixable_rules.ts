/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Option 2 — which rules get an "✨ Ask Olly to fix" action.
 *
 * The AI tier is reserved for diagnostics that have NO unambiguous deterministic
 * rewrite (design Idea V — deterministic-first). Rules that already ship a
 * template fix or whose repair is obvious are deliberately excluded so a user
 * never pays an LLM round-trip for something a local rewrite handles:
 *   - `field-validation` already ships a Levenshtein "did you mean" fix;
 *   - `division-by-zero` has an obvious guard/cast a future template can emit.
 *
 * The genuine gap is multi-clause / type-aware restructures where no template
 * applies. Those rules are listed here. The set is intentionally small and
 * explicit (not "every rule without a `fix`") so adding a rule to the AI tier is
 * a conscious decision, reviewed against the egress/safety surface in §5.6.
 */
export const AI_FIXABLE_RULES: ReadonlySet<string> = new Set<string>([
  'type-mismatch-numeric',
  'enabled-false-object',
  'flat-object-subfield',
  'agg-on-text',
]);

export function isAiFixableRule(ruleId: string | undefined): boolean {
  return ruleId !== undefined && AI_FIXABLE_RULES.has(ruleId);
}
