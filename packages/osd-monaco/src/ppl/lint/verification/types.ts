/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared contract for the PPL lint grammar-verification framework.
 *
 * This framework creates verification assets and test lanes only; it adds no
 * user-facing lint rules. Every other verification module imports the types and
 * status helpers declared here so the fast lane, the (future) runtime-fixture
 * lane, and the report layer never drift.
 *
 * Design reference: `.kiro/specs/ppl-lint-grammar-verification/design.md`.
 */

/**
 * The grammar surfaces the framework can verify.
 *
 * Note the deliberate naming: the *compiled-simplified* surface is the one the
 * lint plugin actually ships (exported as `SimplifiedOpenSearchPPLParser` from
 * `@osd/antlr-grammar`, ~203 parser rules). The *in-repo full proxy* surface
 * (`OpenSearchPPLParser`, ~114 rules) is a smaller in-repository stand-in used
 * before a pinned runtime grammar fixture exists. The *runtime fixture* surface
 * is reconstructed from a checked-in serialized-ATN artifact.
 *
 * These map onto the two-value `LintRunContext.grammarSurface`
 * (`'compiled-simplified' | 'runtime-bundle'`) via {@link runContextSurface}.
 */
export type SurfaceName = 'compiled_simplified' | 'in_repo_full_proxy' | 'runtime_fixture';

/** All surface names, in report order. */
export const ALL_SURFACES: readonly SurfaceName[] = [
  'compiled_simplified',
  'in_repo_full_proxy',
  'runtime_fixture',
];

/** A single classification decision kind for a command in a classification table. */
export type ClassificationDecisionKind = 'included' | 'excluded' | 'not_applicable';

/**
 * How a command affects row ordering, per independently reviewed engine facts.
 * This is *added detector semantics* (the shipping `head-without-sort` rule has
 * no such table today), so it is marked as reviewed rather than hoisted.
 */
export type OrderEffectDecision =
  | 'establishes_order'
  | 'preserves_order'
  | 'destroys_order'
  | 'reverses_order'
  | 'not_applicable';

/**
 * A single manifest decision for a command within one classification table.
 * `reason` is required (1..500 chars after trim) for `excluded`/`not_applicable`
 * decisions. `compatibilitySurface`, when present, scopes a manifest entry that
 * is intentionally absent from a different surface's live inventory.
 */
export interface ClassificationDecision {
  commandRuleName: string;
  decision: ClassificationDecisionKind;
  reason?: string;
  /**
   * Surfaces this decision applies to. The census only requires/checks a
   * decision on surfaces in its scope, and only flags a command absent from a
   * surface's inventory as stale when that surface is in scope. Absent means all
   * surfaces. This lets differently-sized surfaces (compiled ~203 rules, proxy
   * ~114, runtime) share one manifest without cross-surface false positives.
   */
  surfaceScope?: readonly SurfaceName[];
  /** Present only on order-effect table entries (added detector semantics). */
  orderEffect?: OrderEffectDecision;
}

/** A reference a detector resolves dynamically by grammar rule name. */
export interface RuleReference {
  detectorId: string;
  ruleName: string;
  /** Surfaces on which this reference is expected to resolve. */
  appliesTo: readonly SurfaceName[];
  /** Surfaces on which resolution is intentionally skipped. */
  excludedSurfaces?: readonly SurfaceName[];
  /** When true, resolution is pending until a runtime fixture exists. */
  runtimeOnly?: boolean;
}

/** A named parse-tree location expected by a {@link ShapeAssertion}. */
export interface TreeAnchor {
  /** Anchor identifier, unique within the assertion. */
  name: string;
  /** Grammar rule name the anchor node must be an instance of. */
  ruleName: string;
  /** When present, the anchor node's text must equal this exactly. */
  text?: string;
  /** When present, the anchor node's text must satisfy this predicate. */
  predicate?: TextPredicate;
}

/** A text constraint on an anchor node. */
export type TextPredicate =
  | { kind: 'equals'; value: string }
  | { kind: 'includes'; value: string }
  | { kind: 'matches'; source: string };

/** A relationship that must hold between two resolved anchors. */
export type TreeRelationship =
  | { kind: 'ancestor_of'; ancestor: string; descendant: string }
  | { kind: 'parent_of'; parent: string; child: string }
  | { kind: 'precedes_sibling'; first: string; second: string };

/**
 * A canonical parse-tree shape assumption a detector depends on but that
 * rule-name resolution alone cannot prove. Each is a self-contained testable
 * unit: canonical query, expected anchors, expected relationships, rule id, and
 * surface scope.
 */
export interface ShapeAssertion {
  assertionId: string;
  ruleId: string;
  applicableSurfaces: readonly SurfaceName[];
  notApplicableSurfaces: readonly SurfaceName[];
  canonicalQuery: string;
  expectedAnchors: readonly TreeAnchor[];
  expectedRelationships: readonly TreeRelationship[];
}

/**
 * The reflectable source of detector assumptions imported by verification (and,
 * where a category is a behavior-preserving hoist, by detectors too).
 */
export interface ClassificationManifest {
  /** Command rule names recognized as pipeline stages (hoisted from pipeline_shape). */
  commandRuleNames: readonly string[];
  /** Rules whose text carries a (possibly dotted) field path (hoisted from rule_index). */
  dottedPathRules: readonly string[];
  /** Subtree roots whose field references belong to a different source. */
  alternateSourceRules: readonly string[];
  /**
   * Operators whose literal-zero right operand yields null rather than an error.
   * Exactly `['/']` until reviewed engine evidence expands the set.
   */
  zeroDivisorOperators: readonly string[];
  /**
   * Order-effect decisions keyed by command rule name. Added detector semantics,
   * not a hoist — treated as reviewed evidence, cross-checked against the
   * engine-facts baseline.
   */
  orderEffectByCommand: Readonly<Record<string, ClassificationDecision>>;
  /**
   * Classification tables keyed by table name. Each table holds one decision per
   * command it scopes. The census requires exactly one decision per
   * command/table/surface.
   */
  tableExclusions: Readonly<Record<string, readonly ClassificationDecision[]>>;
  /** Every rule name a detector resolves dynamically, for the silent no-op guard. */
  navigatedRuleReferences: readonly RuleReference[];
  /** Parse-shape assumptions the detectors depend on. */
  shapeAssertions: readonly ShapeAssertion[];
}

/* ------------------------------------------------------------------ *
 * Report model
 * ------------------------------------------------------------------ */

/** Verification lanes. */
export type Lane = 'fast' | 'runtime_fixture' | 'heavy_live_cluster';

/** The check categories a report can carry a status for. */
export type CheckCategory =
  | 'manifest'
  | 'inventory'
  | 'no-op'
  | 'census'
  | 'shape'
  | 'behavioral'
  | 'version-context'
  | 'metamorphic'
  | 'runtime-fixture-setup'
  | 'cross-surface'
  | 'generated-no-throw'
  | 'baseline-drift';

/** The categories a fast-lane report must always report a status for. */
export const FAST_LANE_REQUIRED_CATEGORIES: readonly CheckCategory[] = [
  'manifest',
  'inventory',
  'no-op',
  'census',
  'shape',
  'behavioral',
  'version-context',
  'metamorphic',
];

/** Per-category rollup status. */
export type CheckStatus = 'pass' | 'fail' | 'pending' | 'warning' | 'skipped' | 'not-run';

/** The kind of a single verification entry. */
export type EntryStatus =
  | 'pass'
  | 'failure'
  | 'pending'
  | 'warning'
  | 'skipped'
  | 'context-incomplete'
  | 'blocking';

/** Context fields whose presence makes a failure blocking (vs context-incomplete). */
export interface VerificationContext {
  surface?: SurfaceName;
  detector?: string;
  rule?: string;
  query?: string;
}

/** A single result emitted by a verification check. */
export interface VerificationEntry {
  category: CheckCategory;
  status: EntryStatus;
  message: string;
  context: VerificationContext;
}

/** The structured result of a verification lane. */
export interface VerificationReport {
  lane: Lane;
  statuses: Readonly<Record<CheckCategory, CheckStatus>>;
  entries: readonly VerificationEntry[];
  blockingFailures: readonly VerificationEntry[];
  warnings: readonly VerificationEntry[];
  pending: readonly VerificationEntry[];
}

/**
 * A grouped result from a single check. Aggregated into the report by the
 * report builder. `passing` reflects whether the check had zero blocking
 * failures (pending / warning / context-incomplete entries do not fail it).
 */
export interface VerificationResult {
  category: CheckCategory;
  entries: VerificationEntry[];
  passing: boolean;
}

/** Map a framework surface name onto the two-value `LintRunContext.grammarSurface`. */
export function runContextSurface(surface: SurfaceName): 'compiled-simplified' | 'runtime-bundle' {
  return surface === 'runtime_fixture' ? 'runtime-bundle' : 'compiled-simplified';
}

/** True when a failure carries at least one context field (surface/detector/rule/query). */
export function hasContext(context: VerificationContext): boolean {
  return Boolean(context.surface || context.detector || context.rule || context.query);
}
