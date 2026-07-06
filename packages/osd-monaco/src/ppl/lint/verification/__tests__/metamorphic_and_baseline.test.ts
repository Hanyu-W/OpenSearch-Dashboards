/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { compiledSimplifiedSurface, resetSurfaceCache } from '../grammar_surface';
import { ENGINE_FACTS_BASELINE, validateEngineFactsBaseline } from '../engine_facts_baseline';
import {
  compareDetectorTableToBaseline,
  defaultMetamorphicRelations,
  expectedMutantVerdict,
  runMetamorphicRelation,
} from '../metamorphic';
import { CLASSIFICATION_MANIFEST } from '../classification_manifest';

describe('EngineFactsBaseline (Property 11: reviewed test oracle)', () => {
  it('validates structural invariants (non-empty ids, evidence per fact)', () => {
    const result = validateEngineFactsBaseline(ENGINE_FACTS_BASELINE);
    expect(result.passing).toBe(true);
  });

  it('records at least one evidence reference for every command fact', () => {
    for (const [command, fact] of Object.entries(ENGINE_FACTS_BASELINE.commands)) {
      expect(fact.evidence.length).toBeGreaterThan(0);
      expect(command.endsWith('Command')).toBe(true);
    }
  });

  it('fails validation when a command fact lacks evidence', () => {
    const tampered = {
      ...ENGINE_FACTS_BASELINE,
      commands: { badCommand: { orderEffect: 'preserves_order' as const, evidence: [] } },
    };
    expect(validateEngineFactsBaseline(tampered).passing).toBe(false);
  });
});

describe('Metamorphic relations (Property 10: independent oracle)', () => {
  beforeEach(resetSurfaceCache);

  it('derives the expected verdict purely from the baseline order effect', () => {
    // Order-preserving: verdict unchanged.
    expect(expectedMutantVerdict(false, 'preserves_order')).toBe(false);
    expect(expectedMutantVerdict(true, 'preserves_order')).toBe(true);
    // Order-destroying: a quiet seed becomes firing.
    expect(expectedMutantVerdict(false, 'destroys_order')).toBe(true);
    // Reverse: follows the reverse expectation (default identical).
    expect(expectedMutantVerdict(false, 'reverses_order', 'identical')).toBe(false);
    expect(expectedMutantVerdict(false, 'reverses_order', 'mutant_fires_when_seed_quiet')).toBe(
      true
    );
  });

  it('order-preserving and reverse relations hold against the shipping detector', () => {
    const surface = compiledSimplifiedSurface();
    const relations = defaultMetamorphicRelations().filter(
      (r) => r.insertedCommandRuleName !== 'statsCommand'
    );
    for (const relation of relations) {
      const result = runMetamorphicRelation(relation, ENGINE_FACTS_BASELINE, surface);
      if (!result.passing) {
        throw new Error(
          `${relation.relationId}: ` + result.entries.map((e) => e.message).join('; ')
        );
      }
      expect(result.passing).toBe(true);
    }
  });

  it('the order-destroying relation surfaces as a maintainer-review WARNING (not a blocking failure)', () => {
    const surface = compiledSimplifiedSurface();
    const stats = defaultMetamorphicRelations().find(
      (r) => r.insertedCommandRuleName === 'statsCommand'
    )!;
    const result = runMetamorphicRelation(stats, ENGINE_FACTS_BASELINE, surface);
    // The detector under-fires vs the oracle; this is a known limitation, so the
    // relation "passes" (non-blocking) but emits a warning.
    expect(result.passing).toBe(true);
    expect(
      result.entries.some((e) => e.status === 'warning' && e.message.includes('sawSort'))
    ).toBe(true);
  });

  it('a NON-flagged order-destroying relation that under-fires is a BLOCKING failure', () => {
    const surface = compiledSimplifiedSurface();
    // Same stats mutation but WITHOUT knownDetectorUnderFire → must block, not warn.
    const stats = defaultMetamorphicRelations().find(
      (r) => r.insertedCommandRuleName === 'statsCommand'
    )!;
    const unflagged = { ...stats, relationId: 'stats-unflagged', knownDetectorUnderFire: false };
    const result = runMetamorphicRelation(unflagged, ENGINE_FACTS_BASELINE, surface);
    expect(result.passing).toBe(false);
    expect(result.entries.some((e) => e.status === 'failure')).toBe(true);
  });

  it('fails setup when the baseline lacks an order-effect fact for the inserted command', () => {
    const surface = compiledSimplifiedSurface();
    const relation = {
      relationId: 'missing-fact',
      ruleId: 'head-without-sort' as const,
      seedQuery: 'source=t | sort a | head 5',
      insertedCommandRuleName: 'noSuchCommand',
      insertedCommandText: 'nosuch',
    };
    const result = runMetamorphicRelation(relation, ENGINE_FACTS_BASELINE, surface);
    expect(result.passing).toBe(false);
    expect(result.entries[0].message).toContain('Missing order-effect fact');
    // The seed query is preserved in the failure context.
    expect(result.entries[0].context.query).toBe(relation.seedQuery);
  });

  it('detector order-effect table agrees with the baseline (or warns)', () => {
    const result = compareDetectorTableToBaseline(CLASSIFICATION_MANIFEST, ENGINE_FACTS_BASELINE);
    // The manifest table is authored to agree with the baseline; no hard failure.
    expect(result.passing).toBe(true);
  });
});
