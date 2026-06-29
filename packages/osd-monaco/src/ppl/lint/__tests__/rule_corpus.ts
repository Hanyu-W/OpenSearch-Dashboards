/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { LintRunContext } from '../types';

/**
 * Option 1, Layer B — the in-process behavioral corpus.
 *
 * For each lint rule this declares triggering ("positive") and control
 * ("negative") PPL snippets plus the context the rule needs, so a single
 * corpus-driven matrix can assert — on *both* grammar surfaces (compiled
 * simplified + runtime bundle) — that the rule fires on its positives and stays
 * silent on its controls. This generalizes the per-rule `.test.ts` files into
 * one table so a newly-added rule gets cross-surface coverage by adding a row,
 * not a new suite. No cluster needed; it runs wherever the lint jest suite runs.
 *
 * `surfaces` records where a case is expected to fire. A runtime-only rule
 * (`union-min-datasets`, `multisearch-min-subsearch`) never fires on the
 * compiled surface — its command rule is absent there, so the detector no-ops —
 * so its positive is asserted only on `runtime`, while it must still stay silent
 * on `compiled`. Each `negative` is expected silent on every surface.
 *
 * Cases assert on the *specific* target rule id, not the whole diagnostic set:
 * `field-validation` fires on any unknown field reference, so an unrelated
 * snippet can carry incidental diagnostics that are irrelevant to the rule under
 * test. Asserting `ids.includes(ruleId)` keeps each row independent.
 */

export type GrammarSurface = 'compiled' | 'runtime';

/** A single triggering snippet and the context that makes its rule applicable. */
export interface CorpusCase {
  /** The PPL query. */
  ppl: string;
  /** The lint context the rule needs (fields/typeMap/version/engine/settings). */
  context?: LintRunContext;
  /** A short note explaining what the snippet exercises. */
  note?: string;
}

export interface RuleCorpus {
  /** The rule id under test (matches a `rules_catalog.json` entry). */
  ruleId: string;
  /** Surfaces on which the positives are expected to FIRE. Negatives must stay
   * silent on ALL surfaces regardless of this list. */
  surfaces: GrammarSurface[];
  /** Snippets that MUST raise `ruleId`. */
  positives: CorpusCase[];
  /** Snippets that MUST NOT raise `ruleId` (control queries of the same shape). */
  negatives: CorpusCase[];
}

// Shared contexts. A non-empty `fields` set is required for runLint to even
// reach a `needsContext` rule (see lint_runner.ts isContextEmpty), so every
// context below carries one even when the rule only reads `typeMap`/`settings`.
const TYPE_MAP = new Map<string, string>([
  ['age', 'long'],
  ['balance', 'long'],
  ['firstname', 'text'],
  ['state', 'text'],
  ['attributes', 'flat_object'],
  ['raw', 'object'],
]);
const FIELDS = new Set<string>([...TYPE_MAP.keys()]);

const CTX_FIELDS_ONLY: LintRunContext = { fields: FIELDS };
const CTX_WITH_TYPES: LintRunContext = { fields: FIELDS, typeMap: TYPE_MAP };
const CTX_CALCITE_37: LintRunContext = {
  fields: FIELDS,
  isCalcite: true,
  dataSourceVersion: '3.7.0',
};
const CTX_V34: LintRunContext = { fields: FIELDS, dataSourceVersion: '3.4.0' };
const CTX_JOINS_RESTRICTED: LintRunContext = {
  fields: FIELDS,
  settings: { allJoinTypesAllowed: false },
};
// enabled-false-object reads `disabledObjectFields` (object fields mapped
// enabled:false — absent from _field_caps, so sourced separately); self-suppress
// without it. `raw` is the object root here, matching silent_failure_rules.test.
const CTX_DISABLED_OBJ: LintRunContext = {
  fields: FIELDS,
  typeMap: TYPE_MAP,
  disabledObjectFields: new Set(['raw']),
};
// wildcard-source-zero-match reads `visibleIndices`; a non-empty list is "we
// know what's visible", so a wildcard matching none of them fires.
const CTX_VISIBLE_INDICES: LintRunContext = {
  fields: FIELDS,
  visibleIndices: ['accounts', 'logs-2024', 'logs-2025'],
};
// Calcite-gated, runtime-only rules (replace/dedup) need isCalcite + a version
// at/above their minVersion to fire on the runtime surface.
const CTX_CALCITE_34: LintRunContext = {
  fields: FIELDS,
  isCalcite: true,
  dataSourceVersion: '3.4.0',
};

export const RULE_CORPUS: RuleCorpus[] = [
  {
    ruleId: 'division-by-zero',
    surfaces: ['compiled', 'runtime'],
    positives: [
      { ppl: 'source=accounts | eval x = balance / 0', note: 'literal zero divisor' },
      { ppl: 'source=accounts | eval x = balance / 0.0', note: 'decimal zero' },
      { ppl: 'source=accounts | eval x = balance / (0)', note: 'parenthesized zero' },
      { ppl: 'source=accounts | eval x = balance / -0', note: 'signed zero' },
    ],
    negatives: [
      { ppl: 'source=accounts | eval x = balance / 2', note: 'non-zero divisor' },
      { ppl: 'source=accounts | eval x = balance % 0', note: 'modulo, not division' },
    ],
  },
  {
    ruleId: 'head-without-sort',
    surfaces: ['compiled', 'runtime'],
    positives: [{ ppl: 'source=accounts | head 10', note: 'head with no preceding sort' }],
    negatives: [
      { ppl: 'source=accounts | sort age | head 10', note: 'sort precedes head' },
      { ppl: 'source=accounts | where age > 30', note: 'no head at all' },
    ],
  },
  {
    ruleId: 'agg-on-text',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=accounts | stats avg(firstname)',
        context: CTX_WITH_TYPES,
        note: 'numeric agg over a text field',
      },
    ],
    negatives: [
      {
        ppl: 'source=accounts | stats avg(balance)',
        context: CTX_WITH_TYPES,
        note: 'numeric agg over a numeric field',
      },
      {
        ppl: 'source=accounts | stats count(firstname)',
        context: CTX_WITH_TYPES,
        note: 'type-agnostic agg',
      },
      {
        ppl: 'source=accounts | stats avg(firstname)',
        context: CTX_FIELDS_ONLY,
        note: 'self-suppress without a typeMap',
      },
    ],
  },
  {
    ruleId: 'type-mismatch-numeric',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=accounts | where age = "thirty"',
        context: CTX_WITH_TYPES,
        note: 'numeric field = non-numeric string',
      },
      {
        ppl: 'source=accounts | where "thirty" = age',
        context: CTX_WITH_TYPES,
        note: 'reversed operand order',
      },
    ],
    negatives: [
      {
        ppl: 'source=accounts | where age = "32"',
        context: CTX_WITH_TYPES,
        note: 'coercible quoted number',
      },
      {
        ppl: 'source=accounts | where firstname = "AMY"',
        context: CTX_WITH_TYPES,
        note: 'text field comparison',
      },
      {
        ppl: 'source=accounts | where age = 30',
        context: CTX_WITH_TYPES,
        note: 'numeric literal, no mismatch',
      },
    ],
  },
  {
    ruleId: 'invalid-capture-group-name',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=logs | rex field=msg "(?<bad-name>\\d+)"',
        note: 'hyphen in capture group name',
      },
      {
        ppl: 'source=logs | rex field=msg "(?P<good>\\d+)"',
        note: 'Python (?P<...>) opener is rejected even with a valid name',
      },
    ],
    negatives: [
      {
        ppl: 'source=logs | rex field=msg "(?<good>\\d+)"',
        note: 'valid Java capture group name',
      },
    ],
  },
  {
    ruleId: 'disabled-join-type',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=a | cross join left=l right=r on l.id = r.id b',
        context: CTX_JOINS_RESTRICTED,
        note: 'cross join disabled by default',
      },
    ],
    negatives: [
      {
        ppl: 'source=a | inner join left=l right=r on l.id = r.id b',
        context: CTX_JOINS_RESTRICTED,
        note: 'inner join is allowed',
      },
      {
        ppl: 'source=a | cross join left=l right=r on l.id = r.id b',
        context: { ...CTX_JOINS_RESTRICTED, settings: { allJoinTypesAllowed: true } },
        note: 'suppressed when all join types are allowed',
      },
    ],
  },
  {
    // Runtime-only: `unionCommand` is absent on the compiled surface, so the
    // detector no-ops there. Positive fires only on `runtime`; the negatives
    // (and the positive snippet itself) must stay silent on `compiled`.
    ruleId: 'union-min-datasets',
    surfaces: ['runtime'],
    positives: [
      {
        ppl: 'source=a | union [ source=b ]',
        context: CTX_CALCITE_37,
        note: 'union with a single dataset',
      },
    ],
    negatives: [
      {
        ppl: 'source=a | union [ source=b ] [ source=c ]',
        context: CTX_CALCITE_37,
        note: 'union with two datasets',
      },
      {
        ppl: 'source=a | union [ source=b ]',
        context: { fields: FIELDS, isCalcite: false, dataSourceVersion: '3.7.0' },
        note: 'suppressed off Calcite',
      },
    ],
  },
  {
    // field-validation is intentionally NOT in this corpus: on the compiled
    // simplified grammar the `source` fromClause keyword is itself flagged as an
    // unknown field (a known compiled-surface quirk not fixed on this branch), so
    // every source-first snippet trips it on compiled and the cross-surface
    // "negatives stay silent everywhere" invariant can't hold. It is allowlisted
    // in rule_corpus.test.ts (UNCHECKABLE_OFFLINE) with that reason; its real
    // behavior is covered by the analyzer/field-validation suites and the live
    // oracle (Layer C).
    ruleId: 'flat-object-subfield',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=accounts | fields attributes.http.method',
        context: CTX_WITH_TYPES,
        note: 'subfield of a flat_object field (unqueryable in PPL)',
      },
      {
        ppl: 'source=accounts | fields attributes',
        context: CTX_WITH_TYPES,
        note: 'bare flat_object root is also unqueryable',
      },
    ],
    negatives: [
      {
        ppl: 'source=accounts | fields balance',
        context: CTX_WITH_TYPES,
        note: 'a non-flat_object field',
      },
      {
        ppl: 'source=accounts | fields attributes.http.method',
        context: CTX_FIELDS_ONLY,
        note: 'self-suppress without a typeMap',
      },
    ],
  },
  {
    ruleId: 'enabled-false-object',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=accounts | fields raw.k.deep',
        context: CTX_DISABLED_OBJ,
        note: 'field inside an enabled:false object (resolves to null)',
      },
    ],
    negatives: [
      {
        ppl: 'source=accounts | fields raw',
        context: CTX_DISABLED_OBJ,
        note: 'the object root itself is not flagged',
      },
      {
        ppl: 'source=accounts | fields raw.k.deep',
        context: CTX_WITH_TYPES,
        note: 'self-suppress without the disabledObjectFields set',
      },
    ],
  },
  {
    ruleId: 'expand-on-non-array',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=accounts | expand firstname',
        context: CTX_WITH_TYPES,
        note: 'expand on a text (non-array) field',
      },
    ],
    negatives: [
      {
        ppl: 'source=accounts | expand raw',
        context: CTX_WITH_TYPES,
        note: 'expand on an object (array-like) field is allowed',
      },
      {
        ppl: 'source=accounts | expand firstname',
        context: CTX_FIELDS_ONLY,
        note: 'self-suppress without a typeMap',
      },
    ],
  },
  {
    // Runtime-only: on the compiled surface the wildcard source pattern does not
    // reach the tableSource shape the detector keys on, so it no-ops there.
    ruleId: 'wildcard-source-zero-match',
    surfaces: ['runtime'],
    positives: [
      {
        ppl: 'source=nope-* | head 1',
        context: CTX_VISIBLE_INDICES,
        note: 'wildcard pattern matching none of the visible indices',
      },
    ],
    negatives: [
      {
        ppl: 'source=logs-* | head 1',
        context: CTX_VISIBLE_INDICES,
        note: 'wildcard pattern matching at least one visible index',
      },
      {
        ppl: 'source=nope-* | head 1',
        context: CTX_FIELDS_ONLY,
        note: 'self-suppress without a visible-index list',
      },
    ],
  },
  {
    ruleId: 'dedup-consecutive-unsupported',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=accounts | dedup state consecutive=true',
        context: CTX_CALCITE_34,
        note: 'dedup consecutive=true relies on Calcite fallback',
      },
    ],
    negatives: [
      {
        ppl: 'source=accounts | dedup state consecutive=false',
        context: CTX_CALCITE_34,
        note: 'consecutive=false is natively supported',
      },
      {
        ppl: 'source=accounts | dedup state consecutive=true',
        context: { fields: FIELDS, isCalcite: false, dataSourceVersion: '3.4.0' },
        note: 'suppressed off Calcite',
      },
    ],
  },
  {
    // Runtime-only + Calcite-gated: `replacePair` is absent on the compiled
    // surface, so the detector no-ops there (mirrors union-min-datasets).
    ruleId: 'replace-wildcard-asymmetry',
    surfaces: ['runtime'],
    positives: [
      {
        ppl: 'source=accounts | replace "a*b*" with "c*" in state',
        context: CTX_CALCITE_34,
        note: 'asymmetric wildcard counts (2 in pattern, 1 in replacement)',
      },
    ],
    negatives: [
      {
        ppl: 'source=accounts | replace "a*b*" with "c*d*" in state',
        context: CTX_CALCITE_34,
        note: 'symmetric wildcard counts',
      },
      {
        ppl: 'source=accounts | replace "a*b*" with "c*" in state',
        context: { fields: FIELDS, isCalcite: false, dataSourceVersion: '3.4.0' },
        note: 'suppressed off Calcite',
      },
    ],
  },
  {
    ruleId: 'unsupported-window-function-in-eventstats',
    surfaces: ['compiled', 'runtime'],
    positives: [
      {
        ppl: 'source=accounts | eventstats rank() as r by state',
        context: CTX_FIELDS_ONLY,
        note: 'rank is not a supported window function (only row_number is)',
      },
    ],
    negatives: [
      {
        ppl: 'source=accounts | eventstats row_number() as r by state',
        context: CTX_FIELDS_ONLY,
        note: 'row_number is supported',
      },
      {
        ppl: 'source=accounts | eventstats avg(balance) as a by state',
        context: CTX_FIELDS_ONLY,
        note: 'a plain aggregate is not a window function',
      },
    ],
  },
  {
    // Runtime-only AND fixture-limited: the bundled grammar fixture parses
    // `multisearch` as a bare identifier rather than a `multisearchCommand`
    // (the fixture predates the command), so no surface available to this
    // offline suite can exercise the positive. Per the design's
    // "abstain rather than fake agreement" principle, we assert only what is
    // checkable here: it must stay silent on the compiled surface. The
    // runtime-positive is covered by the live engine oracle (Layer C), not here.
    ruleId: 'multisearch-min-subsearch',
    surfaces: [],
    positives: [],
    negatives: [
      {
        ppl: 'source=a | multisearch [ source=b ] [ source=c ]',
        context: CTX_V34,
        note: 'multisearch never fires on the compiled surface (command absent)',
      },
    ],
  },
];
