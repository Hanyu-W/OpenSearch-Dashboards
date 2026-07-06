/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { VerificationReportBuilder } from './report';
import { CLASSIFICATION_MANIFEST, SHAPE_ASSERTIONS } from './classification_manifest';
import { validateManifest } from './manifest_validation';
import { GrammarSurface, localFastLaneSurfaces } from './grammar_surface';
import { deriveCommandInventory } from './grammar_command_inventory';
import { assertAllNavigatedRulesResolve } from './silent_no_op_guard';
import { assertClassificationCompleteness } from './conformance_census';
import { evaluateShapeAssertion, isShapeApplicable } from './shape_evaluator';
import { assertRoundTrip } from './parser_adapter';
import { runLabeledCase, LabeledQueryCase } from './behavioral_corpus';
import { LABELED_CASES } from './corpus/labeled_cases';
import { runVersionContextMatrix, VERSION_CONTEXT_CASES } from './version_context_matrix';
import { generateDescriptorCases, processGeneratedCase } from './generated_cases';
import {
  ENGINE_FACTS_BASELINE,
  EngineFactsBaseline,
  validateEngineFactsBaseline,
} from './engine_facts_baseline';
import {
  compareDetectorTableToBaseline,
  defaultMetamorphicRelations,
  MetamorphicRelation,
  runMetamorphicRelation,
} from './metamorphic';
import {
  isRuntimeSetupUnavailable,
  RuntimeGrammarFixture,
  RuntimeSurfaceSetupResult,
  setupRuntimeFixture,
} from './runtime_grammar_fixture';
import { ClassificationManifest, SurfaceName, VerificationReport } from './types';

/** Inputs to the fast-lane run. Everything defaults to the shipping assets. */
export interface FastLaneInput {
  manifest?: ClassificationManifest;
  surfaces?: GrammarSurface[];
  labeledCases?: readonly LabeledQueryCase[];
  metamorphicRelations?: readonly MetamorphicRelation[];
  engineFactsBaseline?: EngineFactsBaseline;
  /** When absent, runtime-fixture coverage is reported pending (R1.7). */
  runtimeFixture?: RuntimeGrammarFixture;
}

/**
 * The primary fast lane: local surfaces only, zero cluster/network calls. Emits
 * a status for every required category and labels runtime-fixture coverage
 * pending while the fixture is absent (R1.1-R1.7, R14.1).
 */
export function runFastLaneVerification(input: FastLaneInput = {}): VerificationReport {
  const manifest = input.manifest ?? CLASSIFICATION_MANIFEST;
  const surfaces = input.surfaces ?? localFastLaneSurfaces();
  const labeledCases = input.labeledCases ?? LABELED_CASES;
  const metamorphicRelations = input.metamorphicRelations ?? defaultMetamorphicRelations();
  const baseline = input.engineFactsBaseline ?? ENGINE_FACTS_BASELINE;

  const builder = new VerificationReportBuilder('fast');

  // Manifest structural invariants + engine-facts baseline validity.
  builder.add(validateManifest(manifest));
  builder.add(validateEngineFactsBaseline(baseline));

  // Per-surface: inventory, no-op, census, shapes, round trips.
  for (const surface of surfaces) {
    const inventory = deriveCommandInventory(surface);

    // Surface inventory presence + derivation warnings surface as report entries.
    builder.addPass(
      'inventory',
      `Derived ${inventory.commandRules.size} command rules on ${surface.name}.`,
      {
        surface: surface.name,
      }
    );
    for (const warning of inventory.derivationWarnings) {
      builder.addWarning('inventory', warning.message, { surface: surface.name });
    }
    for (const comparison of inventory.comparisonResults) {
      if (comparison.unexpected) {
        builder.addFailure('inventory', comparison.message, { surface: surface.name });
      }
    }

    builder.add(
      assertAllNavigatedRulesResolve(surface, manifest, { runtimeFixtureAvailable: false })
    );
    builder.add(assertClassificationCompleteness(surface, inventory, manifest));

    for (const assertion of SHAPE_ASSERTIONS) {
      if (isShapeApplicable(assertion, surface)) {
        builder.add(evaluateShapeAssertion(assertion, surface));
      }
    }

    // Round-trip a small set of canonical queries on this surface.
    for (const query of roundTripQueries(labeledCases, surface.name)) {
      builder.add(assertRoundTrip(query, surface));
    }
  }

  // Behavioral corpus runs on the compiled surface (the shipping one).
  const compiled = surfaces.find((s) => s.name === 'compiled_simplified');
  if (compiled) {
    for (const testCase of labeledCases) {
      if (testCase.grammarSurface === 'compiled_simplified') {
        builder.add(runLabeledCase(testCase, compiled));
      }
    }

    // Version/context matrix (surface-independent).
    builder.add(runVersionContextMatrix(VERSION_CONTEXT_CASES));

    // Bounded generated coverage.
    for (const generated of generateDescriptorCases(compiled)) {
      builder.add(processGeneratedCase(generated, compiled));
    }

    // Metamorphic relations, oracle = engine-facts baseline.
    builder.add(compareDetectorTableToBaseline(manifest, baseline));
    for (const relation of metamorphicRelations) {
      builder.add(runMetamorphicRelation(relation, baseline, compiled));
    }
  }

  // Runtime-fixture coverage: pending while absent, else set up + labeled.
  const setup: RuntimeSurfaceSetupResult = setupRuntimeFixture(input.runtimeFixture);
  if (isRuntimeSetupUnavailable(setup)) {
    if (setup.pending) {
      builder.addPending(
        'runtime-fixture-setup',
        'Runtime_Fixture_Surface coverage is unavailable (fixture absent).'
      );
    } else {
      builder.addFailure('runtime-fixture-setup', setup.message, { surface: 'runtime_fixture' });
    }
  } else {
    builder.addPass('runtime-fixture-setup', 'Runtime fixture setup passed.', {
      surface: 'runtime_fixture',
    });
  }

  return builder.finalize();
}

/** The canonical queries to round-trip per surface (labeled cases for that surface + shapes). */
function roundTripQueries(
  labeledCases: readonly LabeledQueryCase[],
  surfaceName: SurfaceName
): string[] {
  const queries = new Set<string>();
  for (const testCase of labeledCases) {
    if (testCase.grammarSurface === surfaceName) {
      queries.add(testCase.query);
    }
  }
  return [...queries];
}
