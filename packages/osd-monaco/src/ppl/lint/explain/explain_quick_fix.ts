/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tier-1 quick-fix for the explain-backed performance rules (design §7.2).
 *
 * A pushdown problem often comes from arithmetic on the field side of a filter
 * predicate — `age - 2 > 30` — which forces OpenSearch to evaluate the filter
 * per-document (as a script) or in the coordinator instead of using the index.
 * Moving the arithmetic to the literal side produces an equivalent predicate
 * that pushes natively.
 *
 * The bar (diagnostic.ts `DiagnosticFix`): a fix is attached ONLY when the
 * rewrite is unambiguous, result-preserving, and would not re-fire the rule.
 * Everything here is derived from the comparison's SOURCE TEXT (the plan carries
 * no source offsets), matched against one narrow single-comparison shape, so the
 * compound / multi-field / non-bare-field cases simply do not match and get no
 * fix.
 *
 * ONE shape ships in Tier 1: **additive on an integer field**
 * (`field ± c  CMP  L` → `field CMP  L∓c`, where `field` is an integer-mapped
 * column and `c`, `L` are integer literals). This is the only case that is exact
 * by construction:
 *
 *  - Integer arithmetic on the engine is exact (no rounding), and adding a
 *    constant to both sides never rounds and never flips a comparison, so the
 *    rewrite preserves the result set for every value. Verified live (design
 *    F4/F7: `age - 2 > 30` ≡ `age > 32`).
 *  - **Floating-point fields are excluded.** The engine evaluates `field + c` in
 *    IEEE-754, which rounds, while this rewrite is exact — so on a `double`
 *    boundary value the two disagree (e.g. stored `0.2`: `0.2 + 0.1 > 0.3` is
 *    true, but the rewritten `x > 0.2` is false). A wrong semantic rewrite is
 *    strictly worse than the slowness it fixes (design non-goal), so float
 *    additive is deferred to Tier 2 (needs FP-aware boundary arithmetic).
 *  - **The divisive form is excluded from Tier 1 entirely.** On an integer field
 *    `/` truncates toward zero, so the inversion depends on the field's
 *    (unknowable-at-lint-time) value sign; on a floating field `/` is IEEE-754
 *    real division, which multiplication does not exactly invert at boundaries.
 *    Neither is exact-by-construction from a type map alone — deferred to Tier 2.
 *  - Integer overflow at the type extreme (Java `long` wraps; this rewrite does
 *    not) is an accepted residual for interactive queries (design open-question
 *    §11.3) — a real value at `Long.MAX_VALUE` is not a case we optimize for.
 */

/** OpenSearch integer-family numeric types, by `esTypes[0]` as carried in `typeMap`. */
const INTEGER_TYPES = new Set(['long', 'integer', 'short', 'byte']);

/** A field ref: a dotted path or a backtick-quoted name. No parens (excludes fn calls). */
const FIELD = '(`[^`]+`|[A-Za-z_][\\w.]*)';
/** Comparison operators PPL accepts. Longer forms first so `<=`/`>=`/`!=` win. */
const CMP = '(<=|>=|!=|<|>|=)';
/** An unsigned INTEGER constant (the additive constant). No decimal point. */
const UINT = '(\\d+)';
/** A signed INTEGER literal (the RHS of the comparison). No decimal point. */
const SINT = '(-?\\d+)';

const ADDITIVE_RE = new RegExp(`^${FIELD}\\s*([+-])\\s*${UINT}\\s*${CMP}\\s*${SINT}$`);

export interface ExplainFilterFix {
  /** Lightbulb title, previewing the resulting predicate. */
  title: string;
  /** Replacement text for the predicate range. */
  text: string;
  /** The field the predicate acts on, for the hover "Your query" line. */
  field: string;
  /** The compared literal, for the hover "Your query" line. */
  literal: string;
}

/** Strip a backtick-quoted field ref down to its inner name for the type-map lookup. */
function fieldKey(fieldToken: string): string {
  return fieldToken.startsWith('`') && fieldToken.endsWith('`')
    ? fieldToken.slice(1, -1)
    : fieldToken;
}

/**
 * Derive the Tier-1 additive-inversion quick-fix from a comparison's source
 * text, or `undefined` when no provably-safe rewrite applies.
 *
 * `comparisonText` MUST be the source of a single comparison only (the caller
 * passes the `comparisonExpression` node text, which never contains `where` /
 * `NOT` / `and` / `or` keywords — matching those would let a token-fused string
 * like `NOTage` slip past the field pattern). `typeMap` maps a field name to its
 * `esTypes[0]`; the fix is offered only when the field is integer-mapped.
 */
export function buildFilterInversionFix(
  comparisonText: string,
  typeMap?: Map<string, string>
): ExplainFilterFix | undefined {
  const match = ADDITIVE_RE.exec(comparisonText.trim());
  if (!match) {
    return undefined;
  }
  const [, fieldToken, sign, constant, cmp, literal] = match;

  // Integer field only — the rewrite is exact solely under exact integer
  // arithmetic. Unknown or floating-point type → no fix.
  const esType = typeMap?.get(fieldKey(fieldToken));
  if (esType === undefined || !INTEGER_TYPES.has(esType)) {
    return undefined;
  }

  // `field - c CMP L` moves +c across; `field + c CMP L` moves -c across. All
  // BigInt, so exact for integer operands.
  const c = BigInt(constant);
  const l = BigInt(literal);
  const result = (sign === '-' ? l + c : l - c).toString();

  const rewritten = `${fieldToken} ${cmp} ${result}`;
  return {
    title: `Rewrite to \`${rewritten}\` so OpenSearch can use the index`,
    text: rewritten,
    field: fieldKey(fieldToken),
    literal,
  };
}
