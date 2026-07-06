/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { DOTTED_PATH_RULES } from '../rule_index';
import { PIPELINE_COMMAND_RULE_NAMES } from '../pipeline_shape';
import { ZERO_DIVISOR_OPERATORS } from '../rules/division_by_zero';
import { ALTERNATE_SOURCE_SUBTREE_RULES } from '../pipeline_shape';
import {
  ClassificationDecision,
  ClassificationManifest,
  RuleReference,
  ShapeAssertion,
  SurfaceName,
} from './types';
import { SHAPE_ASSERTIONS } from './shape_assertions';

/**
 * One reflectable source of detector assumptions, shared by production detectors
 * (where a category is a behavior-preserving hoist) and by verification.
 *
 * Hoisted (imported from the shipping modules so production and verification can
 * never read different values — R2.2, R2.8):
 *  - {@link PIPELINE_COMMAND_RULE_NAMES} — pipeline stage command rules.
 *  - {@link DOTTED_PATH_RULES} — dotted field-path rules.
 *  - {@link ALTERNATE_SOURCE_SUBTREE_RULES} — alternate-source subtree roots.
 *  - {@link ZERO_DIVISOR_OPERATORS} — zero-divisor operator set (exactly `/`).
 *
 * Added detector semantics (NOT a hoist — reviewed against the engine-facts
 * baseline): {@link ORDER_EFFECT_BY_COMMAND}.
 */

/**
 * Commands whose relative row order the engine preserves, destroys, establishes,
 * or reverses. This table does not exist in `head_without_sort.ts` today (that
 * rule uses only a binary `sawSort`), so it is authored here as *new reviewed
 * detector semantics*, cross-checked against `EngineFactsBaseline`. Every entry
 * carries a reason and evidence lives in the baseline.
 *
 * The classification below is intentionally conservative: only commands with
 * clear, reviewed ordering behavior are marked preserve/destroy. Anything not
 * yet reviewed is `not_applicable` with a reason so the census stays total.
 */
export const ORDER_EFFECT_BY_COMMAND: Readonly<Record<
  string,
  ClassificationDecision
>> = Object.freeze({
  sortCommand: {
    commandRuleName: 'sortCommand',
    decision: 'included',
    orderEffect: 'establishes_order',
    reason: 'sort establishes a total row order over its sort keys.',
  },
  reverseCommand: {
    commandRuleName: 'reverseCommand',
    decision: 'included',
    orderEffect: 'reverses_order',
    reason: 'reverse inverts the current row order without discarding it.',
  },
  headCommand: {
    commandRuleName: 'headCommand',
    decision: 'included',
    orderEffect: 'preserves_order',
    reason: 'head takes a prefix of the current order; it does not reorder rows.',
  },
  fieldsCommand: {
    commandRuleName: 'fieldsCommand',
    decision: 'included',
    orderEffect: 'preserves_order',
    reason: 'fields projects columns and preserves row order.',
  },
  whereCommand: {
    commandRuleName: 'whereCommand',
    decision: 'included',
    orderEffect: 'preserves_order',
    reason: 'where filters rows and preserves the relative order of survivors.',
  },
  evalCommand: {
    commandRuleName: 'evalCommand',
    decision: 'included',
    orderEffect: 'preserves_order',
    reason: 'eval adds computed columns and preserves row order.',
  },
  renameCommand: {
    commandRuleName: 'renameCommand',
    decision: 'included',
    orderEffect: 'preserves_order',
    reason: 'rename changes column names and preserves row order.',
  },
  statsCommand: {
    commandRuleName: 'statsCommand',
    decision: 'included',
    orderEffect: 'destroys_order',
    reason: 'stats aggregates and emits grouped rows in an engine-defined order.',
  },
  dedupCommand: {
    commandRuleName: 'dedupCommand',
    decision: 'included',
    orderEffect: 'preserves_order',
    reason: 'dedup drops duplicate rows and preserves the order of the survivors.',
  },
});

/**
 * Reviewed command inventories per grammar surface. These are the hand-
 * maintained expectation the census compares the *live grammar* inventory
 * against: a command the grammar adds but this list omits, or a command this
 * list names but the grammar drops, fails the census and forces lint review
 * (R4.1-R4.7). The compiled-simplified surface is the shipping one (~203 rules,
 * 35 `*Command`); the in-repo full proxy (~114 rules) is a strict subset.
 *
 * Four pipeline commands the detectors handle — `streamstats`, `replace`,
 * `union`, `multisearch` — are absent from both compiled surfaces and appear
 * only on the runtime grammar, so they are scoped to `runtime_fixture` and not
 * checked until a runtime fixture lands.
 */
const COMPILED_COMMANDS: readonly string[] = [
  'adCommand',
  'appendCommand',
  'appendcolCommand',
  'binCommand',
  'dedupCommand',
  'describeCommand',
  'evalCommand',
  'eventstatsCommand',
  'expandCommand',
  'fieldsCommand',
  'fillnullCommand',
  'flattenCommand',
  'grokCommand',
  'headCommand',
  'joinCommand',
  'kmeansCommand',
  'lookupCommand',
  'mlCommand',
  'parseCommand',
  'patternsCommand',
  'rareCommand',
  'regexCommand',
  'renameCommand',
  'reverseCommand',
  'rexCommand',
  'searchCommand',
  'showDataSourcesCommand',
  'sortCommand',
  'spathCommand',
  'statsCommand',
  'tableCommand',
  'timechartCommand',
  'topCommand',
  'trendlineCommand',
  'whereCommand',
];

const PROXY_COMMANDS: readonly string[] = [
  'adCommand',
  'dedupCommand',
  'describeCommand',
  'evalCommand',
  'fieldsCommand',
  'grokCommand',
  'headCommand',
  'kmeansCommand',
  'mlCommand',
  'parseCommand',
  'patternsCommand',
  'rareCommand',
  'renameCommand',
  'searchCommand',
  'showDataSourcesCommand',
  'sortCommand',
  'statsCommand',
  'topCommand',
  'whereCommand',
];

/** Runtime-only pipeline commands absent from both compiled surfaces. */
const RUNTIME_ONLY_COMMANDS: readonly string[] = [
  'streamstatsCommand',
  'replaceCommand',
  'unionCommand',
  'multisearchCommand',
];

/** Commands that are not pipeline stages (introspection/ML), by surface presence. */
const NON_PIPELINE_COMMANDS: readonly string[] = [
  'adCommand',
  'describeCommand',
  'kmeansCommand',
  'mlCommand',
  'showDataSourcesCommand',
];

/** The surfaces a command appears on, from the reviewed inventories. */
function surfaceScopeFor(command: string): SurfaceName[] {
  const scope: SurfaceName[] = [];
  if (COMPILED_COMMANDS.includes(command)) {
    scope.push('compiled_simplified');
  }
  if (PROXY_COMMANDS.includes(command)) {
    scope.push('in_repo_full_proxy');
  }
  if (RUNTIME_ONLY_COMMANDS.includes(command)) {
    scope.push('runtime_fixture');
  }
  return scope;
}

/** Every command the manifest knows about, across all surfaces. */
const ALL_KNOWN_COMMANDS: readonly string[] = [...COMPILED_COMMANDS, ...RUNTIME_ONLY_COMMANDS];

/**
 * Command-rule classification tables. Each command has exactly one decision per
 * surface it is scoped to; the census enforces totality over the live inventory
 * for the surfaces each table applies to.
 */
const PIPELINE_STAGE_TABLE: readonly ClassificationDecision[] = ALL_KNOWN_COMMANDS.map((name) => {
  const isPipelineStage =
    (PIPELINE_COMMAND_RULE_NAMES as readonly string[]).includes(name) ||
    RUNTIME_ONLY_COMMANDS.includes(name);
  return isPipelineStage
    ? { commandRuleName: name, decision: 'included' as const, surfaceScope: surfaceScopeFor(name) }
    : {
        commandRuleName: name,
        decision: 'not_applicable' as const,
        reason: 'Introspection/ML command; not a pipeline data-transformation stage.',
        surfaceScope: surfaceScopeFor(name),
      };
});

const ALTERNATE_SOURCE_TABLE: readonly ClassificationDecision[] = ALL_KNOWN_COMMANDS.map((name) => {
  // Only command-level alternate sources are classified here (lookupCommand,
  // appendCommand). subSearch / unionDataset are sub-rules, not commands.
  const isAlternate = (ALTERNATE_SOURCE_SUBTREE_RULES as readonly string[]).includes(name);
  return isAlternate
    ? { commandRuleName: name, decision: 'included' as const, surfaceScope: surfaceScopeFor(name) }
    : {
        commandRuleName: name,
        decision: 'not_applicable' as const,
        reason: 'Command does not introduce an alternate field source.',
        surfaceScope: surfaceScopeFor(name),
      };
});

// Keep a reference to NON_PIPELINE_COMMANDS for documentation/review symmetry.
void NON_PIPELINE_COMMANDS;

/** Rule names each detector resolves dynamically (for the silent no-op guard). */
const NAVIGATED_RULE_REFERENCES: readonly RuleReference[] = buildNavigatedRuleReferences();

export const CLASSIFICATION_MANIFEST: ClassificationManifest = Object.freeze({
  commandRuleNames: PIPELINE_COMMAND_RULE_NAMES,
  dottedPathRules: DOTTED_PATH_RULES,
  alternateSourceRules: ALTERNATE_SOURCE_SUBTREE_RULES,
  zeroDivisorOperators: ZERO_DIVISOR_OPERATORS,
  orderEffectByCommand: ORDER_EFFECT_BY_COMMAND,
  tableExclusions: Object.freeze({
    pipeline_stage: PIPELINE_STAGE_TABLE,
    alternate_source: ALTERNATE_SOURCE_TABLE,
  }),
  navigatedRuleReferences: NAVIGATED_RULE_REFERENCES,
  shapeAssertions: SHAPE_ASSERTIONS,
});

/**
 * The rule names detectors resolve by name on the compiled surface. Each entry
 * mirrors a `ruleNameToIndex(...)` / helper call in a shipping rule. Grouped by
 * detector id for failure reporting.
 *
 * `appliesTo` lists the surfaces on which the reference is expected to resolve.
 * Compiled-simplified is the shipping surface; the in-repo full proxy shares
 * most rule names. Runtime-only references (rules that only appear on the
 * deserialized runtime grammar) are marked `runtimeOnly`.
 */
function buildNavigatedRuleReferences(): readonly RuleReference[] {
  const compiled: RuleReference['appliesTo'] = ['compiled_simplified'];
  const refs: RuleReference[] = [];
  const add = (detectorId: string, ruleNames: readonly string[], runtimeOnly = false) => {
    for (const ruleName of ruleNames) {
      refs.push({ detectorId, ruleName, appliesTo: compiled, runtimeOnly });
    }
  };

  add('head-without-sort', ['sortCommand', 'headCommand']);
  add('division-by-zero', ['valueExpression']);
  add('agg-on-text', ['statsFunction', 'statsFunctionName', 'functionArgs', 'fieldExpression']);
  add('dedup-consecutive-unsupported', ['dedupCommand']);
  add('disabled-join-type', ['sqlLikeJoinType', 'joinType', 'joinCommand']);
  add('expand-on-non-array', ['expandCommand', 'fieldExpression']);
  add('flat-object-subfield', ['qualifiedName', 'wcQualifiedName']);
  add('enabled-false-object', ['qualifiedName', 'wcQualifiedName']);
  add('invalid-capture-group-name', ['rexExpr', 'parseCommand', 'grokCommand', 'stringLiteral']);
  // For the catalog `runtimeOnly` detectors, only the rule names that are absent
  // from the compiled grammar are marked runtime-only (guard → pending, R5.6);
  // the rest are still verified on the compiled surface.
  add('multisearch-min-subsearch', ['subSearch']);
  add('multisearch-min-subsearch', ['multisearchCommand'], true);
  add('replace-wildcard-asymmetry', ['stringLiteral']);
  add('replace-wildcard-asymmetry', ['replacePair'], true);
  // type-mismatch reaches the comparison parent via operator.parent (object
  // navigation), NOT by resolving 'expression' by name — so 'expression' is not
  // listed here (it would overstate the no-op guard's coverage).
  add('type-mismatch-numeric', ['stringLiteral', 'fieldExpression', 'comparisonOperator']);
  add('union-min-datasets', ['unionCommand', 'unionDataset'], true);
  add('unsupported-window-function-in-eventstats', [
    'eventstatsCommand',
    'windowFunction',
    'windowFunctionName',
    'scalarWindowFunctionName',
  ]);
  // streamstats only resolves on the runtime grammar.
  add('unsupported-window-function-in-eventstats', ['streamstatsCommand'], true);
  add('wildcard-source-zero-match', ['fromClause', 'tableSource']);
  add('field-validation', [
    'sideAlias',
    'qualifiedName',
    'fromClause',
    'tableSource',
    'tableSourceClause',
    'tableQualifiedName',
    'sourceReference',
    'joinCriteria',
    'evalClause',
    // The grammar rule is genuinely misspelled `renameClasue` on both surfaces;
    // that is the literal the detector resolves. Track the real name so the
    // silent-no-op guard verifies the reference that actually resolves.
    'renameClasue',
    'fieldExpression',
    'comparisonOperator',
    'expression',
    'literalValue',
    'grokCommand',
    'parseCommand',
    'patternsCommand',
  ]);

  return refs;
}

/** Re-export for convenience: shape assertions live in their own module. */
export { SHAPE_ASSERTIONS };
export type { ShapeAssertion };
