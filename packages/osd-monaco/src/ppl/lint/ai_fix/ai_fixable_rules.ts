/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Option 2 — which rules get an "✨ Ask Olly to fix" action.
 *
 * The AI tier is reserved for diagnostics that have NO unambiguous deterministic
 * rewrite (design Idea V — deterministic-first). Two categories are excluded:
 *   - rules that already ship a template/obvious fix, so a user never pays an
 *     LLM round-trip for it: `field-validation` (Levenshtein "did you mean"),
 *     `division-by-zero` (an obvious guard/cast a future template can emit);
 *   - rules whose diagnostic is *unfixable* — no valid rewrite target of any
 *     kind exists: `flat-object-subfield`, whose own detector documents that a
 *     flat_object field cannot be referenced in PPL at all (neither the root, a
 *     flatten, nor a cast works; see flat_object_subfield.ts). Every AI
 *     candidate for it is structurally guaranteed to be rejected (keep the ref →
 *     still raises the rule; drop it → shape/overlap reject), so listing it only
 *     burns a round-trip and shows a lightbulb that can never apply.
 *
 * The genuine gap is multi-clause / type-aware restructures where no template
 * applies BUT a real intent-preserving repair exists (e.g. `enabled-false-object`
 * — a silent null/HTTP-200 failure repairable by referencing a sibling indexed
 * field). Those rules are listed here. The set is intentionally small and
 * explicit (not "every rule without a `fix`") so adding a rule to the AI tier is
 * a conscious decision, reviewed against the egress/safety surface in §5.6.
 */
export const AI_FIXABLE_RULES: ReadonlySet<string> = new Set<string>([
  'type-mismatch-numeric',
  'enabled-false-object',
  // 'flat-object-subfield' is NOT here: diagnostic-only by design (no valid PPL
  // rewrite target exists), so every AI candidate is rejected. See above.
  'agg-on-text',
]);

export function isAiFixableRule(ruleId: string | undefined): boolean {
  return ruleId !== undefined && AI_FIXABLE_RULES.has(ruleId);
}
