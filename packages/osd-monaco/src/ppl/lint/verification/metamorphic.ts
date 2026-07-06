/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLint } from '../lint_runner';
import { getBundledCatalog } from '../catalog';
import { GrammarSurface } from './grammar_surface';
import { EngineFactsBaseline } from './engine_facts_baseline';
import { ClassificationManifest, OrderEffectDecision, VerificationResult } from './types';

/** A single-mutation metamorphic relation for `head-without-sort`. */
export interface MetamorphicRelation {
  relationId: string;
  ruleId: 'head-without-sort';
  /** A quiet seed (`sort ... | head`) — head-without-sort does not fire. */
  seedQuery: string;
  /** The command rule name inserted between sort and head. */
  insertedCommandRuleName: string;
  /** The literal command text to splice in (e.g. `stats count()`). */
  insertedCommandText: string;
  /**
   * Set only for a reviewed, known detector limitation: when the oracle expects
   * the mutant to fire but the shipping detector provably under-fires (its
   * order model is weaker than the engine facts). Such a relation downgrades to
   * a maintainer-review WARNING instead of a blocking failure (R11.5). Any OTHER
   * relation whose mutant verdict diverges from the oracle is a real failure.
   */
  knownDetectorUnderFire?: boolean;
}

/**
 * Enabled `head-without-sort` metamorphic relations. Each seed is quiet
 * (`sort ... | head` — a preceding sort suppresses the rule). Inserting a
 * command between sort and head then either keeps it quiet (order-preserving) or
 * makes it fire (order-destroying), per the *engine-facts baseline* — never the
 * detector's own table.
 */
export function defaultMetamorphicRelations(): MetamorphicRelation[] {
  return [
    {
      relationId: 'head-order-fields-preserving',
      ruleId: 'head-without-sort',
      seedQuery: 'source=t | sort age | fields age | head 5',
      insertedCommandRuleName: 'fieldsCommand',
      insertedCommandText: 'fields age',
    },
    {
      relationId: 'head-order-where-preserving',
      ruleId: 'head-without-sort',
      seedQuery: 'source=t | sort age | head 5',
      insertedCommandRuleName: 'whereCommand',
      insertedCommandText: 'where age > 1',
    },
    {
      relationId: 'head-order-stats-destroying',
      ruleId: 'head-without-sort',
      seedQuery: 'source=t | sort age | head 5',
      insertedCommandRuleName: 'statsCommand',
      insertedCommandText: 'stats count() by age',
      // Reviewed known limitation: head-without-sort uses a binary sawSort and
      // does not re-flag after an order-destroying stats. Downgrades to warning.
      knownDetectorUnderFire: true,
    },
    {
      relationId: 'head-order-reverse',
      ruleId: 'head-without-sort',
      seedQuery: 'source=t | sort age | head 5',
      insertedCommandRuleName: 'reverseCommand',
      insertedCommandText: 'reverse',
    },
  ];
}

/**
 * Run one metamorphic relation. The expected seed→mutant diagnostic relation is
 * derived SOLELY from the {@link EngineFactsBaseline} order effect for the
 * inserted command (R10.1). Missing baseline facts fail setup before any query
 * runs, preserving the seed query in the message (R10.5).
 */
export function runMetamorphicRelation(
  relation: MetamorphicRelation,
  baseline: EngineFactsBaseline,
  surface: GrammarSurface
): VerificationResult {
  const command = relation.insertedCommandRuleName;
  const fact = baseline.commands[command];

  const baseCtx = { rule: relation.ruleId, query: relation.seedQuery, surface: surface.name };

  if (!fact?.orderEffect) {
    return {
      category: 'metamorphic',
      passing: false,
      entries: [
        {
          category: 'metamorphic',
          status: 'failure',
          message: `Missing order-effect fact for "${command}" in baseline "${baseline.baselineId}"; cannot derive expectation.`,
          context: baseCtx,
        },
      ],
    };
  }

  const mutatedQuery = applyInsertion(relation);
  const seedFires = ruleFires(relation.seedQuery, relation.ruleId, surface);
  const mutantFires = ruleFires(mutatedQuery, relation.ruleId, surface);

  const expectMutantFires = expectedMutantVerdict(
    seedFires,
    fact.orderEffect,
    fact.reverseOrderExpectation
  );

  if (mutantFires !== expectMutantFires) {
    // Downgrade to a maintainer-review WARNING only for a relation explicitly
    // marked as a reviewed known limitation (knownDetectorUnderFire) where the
    // detector provably under-fires vs the oracle. Every other divergence —
    // including a NEW order-destroying command that under-fires, or a regression
    // in a currently-correct relation — is a blocking failure (R11.5).
    const detectorUnderFires =
      relation.knownDetectorUnderFire === true && expectMutantFires && !mutantFires;
    const status = detectorUnderFires ? 'warning' : 'failure';
    return {
      category: 'metamorphic',
      // A warning (known detector limitation) is non-blocking → passing; a true
      // violation is blocking → not passing.
      passing: detectorUnderFires,
      entries: [
        {
          category: 'metamorphic',
          status,
          message:
            `Metamorphic relation "${relation.relationId}": inserting ${command} ` +
            `(orderEffect=${fact.orderEffect}) into a ${seedFires ? 'firing' : 'quiet'} seed ` +
            `expected mutant ${expectMutantFires ? 'fires' : 'quiet'}, got ${
              mutantFires ? 'fires' : 'quiet'
            }. ` +
            (detectorUnderFires
              ? 'Detector uses a binary sawSort and does not model order destruction; maintainer review required.'
              : `Mutant: "${mutatedQuery}".`),
          context: baseCtx,
        },
      ],
    };
  }

  return {
    category: 'metamorphic',
    passing: true,
    entries: [
      {
        category: 'metamorphic',
        status: 'pass',
        message: `Metamorphic relation "${relation.relationId}" holds (orderEffect=${fact.orderEffect}).`,
        context: baseCtx,
      },
    ],
  };
}

/**
 * Derive whether the mutant should fire, from the seed verdict + engine fact:
 *  - preserving/establishing/n-a → verdict unchanged (identical).
 *  - destroying → a quiet sorted seed becomes firing (the sort no longer reaches
 *    head); an already-firing seed stays firing.
 *  - reversing → follows the baseline's reverseOrderExpectation (default
 *    identical: reverse keeps a total order, so head is still deterministic).
 */
export function expectedMutantVerdict(
  seedFires: boolean,
  orderEffect: OrderEffectDecision,
  reverseExpectation?: 'identical' | 'mutant_fires_when_seed_quiet'
): boolean {
  switch (orderEffect) {
    case 'destroys_order':
      return true; // quiet→fires, fires→fires
    case 'reverses_order':
      return reverseExpectation === 'mutant_fires_when_seed_quiet' ? true : seedFires;
    case 'preserves_order':
    case 'establishes_order':
    case 'not_applicable':
    default:
      return seedFires;
  }
}

/** Splice the inserted command in immediately before the final `head` stage. */
function applyInsertion(relation: MetamorphicRelation): string {
  const headIdx = relation.seedQuery.lastIndexOf('| head');
  if (headIdx < 0) {
    // No head stage — return unchanged; the relation will fail meaningfully.
    return relation.seedQuery;
  }
  const before = relation.seedQuery.slice(0, headIdx).trimEnd();
  const headPart = relation.seedQuery.slice(headIdx);
  return `${before} | ${relation.insertedCommandText} ${headPart}`;
}

/** True when `ruleId` produces at least one diagnostic on this surface. */
function ruleFires(query: string, ruleId: string, surface: GrammarSurface): boolean {
  let tree;
  try {
    tree = surface.parse(query);
  } catch {
    return false;
  }
  const diagnostics = runLint(tree, {
    ruleNameToIndex: surface.ruleNameToIndex,
    catalog: getBundledCatalog(),
  });
  return diagnostics.some((d) => d.ruleId === ruleId);
}

/**
 * Compare the manifest's detector order-effect table against the independent
 * engine-facts baseline (R11.4, R11.5). A disagreement is a
 * maintainer-review-required failure (the failure mechanism succeeds here). When
 * a command exists in only one source, that is reported as a warning rather than
 * a hard failure.
 */
export function compareDetectorTableToBaseline(
  manifest: ClassificationManifest,
  baseline: EngineFactsBaseline
): VerificationResult {
  const entries: VerificationResult['entries'] = [];
  let passing = true;

  for (const [command, decision] of Object.entries(manifest.orderEffectByCommand)) {
    const fact = baseline.commands[command];
    if (!fact?.orderEffect) {
      entries.push({
        category: 'metamorphic',
        status: 'warning',
        message: `Detector table classifies "${command}" as ${decision.orderEffect} but the baseline has no order-effect fact for it.`,
        context: { rule: command },
      });
      continue;
    }
    if (decision.orderEffect !== fact.orderEffect) {
      passing = false;
      entries.push({
        category: 'metamorphic',
        status: 'failure',
        message: `Order-effect disagreement for "${command}": detector table says ${decision.orderEffect}, baseline says ${fact.orderEffect}. Maintainer review required.`,
        context: { rule: command },
      });
    }
  }

  if (passing && entries.every((e) => e.status !== 'failure')) {
    entries.push({
      category: 'metamorphic',
      status: 'pass',
      message: 'Detector order-effect table agrees with the engine-facts baseline.',
      context: {},
    });
  }
  return { category: 'metamorphic', passing, entries: [...entries] };
}
