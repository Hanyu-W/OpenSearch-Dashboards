/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  compiledSimplifiedSurface,
  inRepoFullProxySurface,
  resetSurfaceCache,
} from '../grammar_surface';
import { deriveCommandInventory, resetInventoryCache } from '../grammar_command_inventory';
import { assertClassificationCompleteness } from '../conformance_census';
import { assertAllNavigatedRulesResolve, classifyApplicability } from '../silent_no_op_guard';
import {
  assertNavigatedReferencesCoverSource,
  extractNavigatedRuleNames,
} from '../navigated_reference_scan';
import { CLASSIFICATION_MANIFEST } from '../classification_manifest';
import { ClassificationManifest, RuleReference } from '../types';

describe('GrammarConformanceCensus (Property 4: total, non-stale)', () => {
  beforeEach(() => {
    resetInventoryCache();
    resetSurfaceCache();
  });

  it('passes on both local surfaces with the shipping manifest', () => {
    for (const surface of [compiledSimplifiedSurface(), inRepoFullProxySurface()]) {
      const inventory = deriveCommandInventory(surface);
      const result = assertClassificationCompleteness(surface, inventory, CLASSIFICATION_MANIFEST);
      if (!result.passing) {
        throw new Error(
          result.entries
            .filter((e) => e.status === 'failure')
            .map((e) => e.message)
            .join('\n')
        );
      }
      expect(result.passing).toBe(true);
    }
  });

  it('fails with a missing-classification error when a command is unclassified', () => {
    const surface = compiledSimplifiedSurface();
    const inventory = deriveCommandInventory(surface);
    // Drop one command's decision from both tables.
    const stripped: ClassificationManifest = {
      ...CLASSIFICATION_MANIFEST,
      tableExclusions: Object.fromEntries(
        Object.entries(CLASSIFICATION_MANIFEST.tableExclusions).map(([name, decisions]) => [
          name,
          decisions.filter((d) => d.commandRuleName !== 'sortCommand'),
        ])
      ),
    };
    const result = assertClassificationCompleteness(surface, inventory, stripped);
    expect(result.passing).toBe(false);
    expect(
      result.entries.some(
        (e) => e.message.includes('sortCommand') && e.message.includes('no classification')
      )
    ).toBe(true);
  });

  it('fails with a duplicate-classification error', () => {
    const surface = compiledSimplifiedSurface();
    const inventory = deriveCommandInventory(surface);
    const dup: ClassificationManifest = {
      ...CLASSIFICATION_MANIFEST,
      tableExclusions: {
        pipeline_stage: [
          ...CLASSIFICATION_MANIFEST.tableExclusions.pipeline_stage,
          {
            commandRuleName: 'sortCommand',
            decision: 'included',
            surfaceScope: ['compiled_simplified'],
          },
        ],
      },
    };
    const result = assertClassificationCompleteness(surface, inventory, dup);
    expect(result.passing).toBe(false);
    expect(
      result.entries.some(
        (e) => e.message.includes('sortCommand') && e.message.includes('classifications')
      )
    ).toBe(true);
  });

  it('flags a stale in-scope command absent from the surface inventory', () => {
    const surface = compiledSimplifiedSurface();
    const inventory = deriveCommandInventory(surface);
    const stale: ClassificationManifest = {
      ...CLASSIFICATION_MANIFEST,
      tableExclusions: {
        pipeline_stage: [
          ...CLASSIFICATION_MANIFEST.tableExclusions.pipeline_stage,
          {
            commandRuleName: 'ghostCommand',
            decision: 'included',
            surfaceScope: ['compiled_simplified'],
          },
        ],
      },
    };
    const result = assertClassificationCompleteness(surface, inventory, stale);
    expect(result.passing).toBe(false);
    expect(
      result.entries.some(
        (e) => e.message.includes('Stale manifest entry') && e.message.includes('ghostCommand')
      )
    ).toBe(true);
  });
});

describe('SilentNoOpGuard (Property 5: names resolve before execution)', () => {
  beforeEach(resetSurfaceCache);

  it('passes on the compiled surface for the shipping manifest', () => {
    const surface = compiledSimplifiedSurface();
    const result = assertAllNavigatedRulesResolve(surface, CLASSIFICATION_MANIFEST);
    if (!result.passing) {
      throw new Error(
        result.entries
          .filter((e) => e.status === 'failure')
          .map((e) => e.message)
          .join('\n')
      );
    }
    expect(result.passing).toBe(true);
  });

  it('fails when an applicable reference does not resolve', () => {
    const surface = compiledSimplifiedSurface();
    const badManifest: ClassificationManifest = {
      ...CLASSIFICATION_MANIFEST,
      navigatedRuleReferences: [
        {
          detectorId: 'ghost-detector',
          ruleName: 'noSuchRule',
          appliesTo: ['compiled_simplified'],
        },
      ],
    };
    const result = assertAllNavigatedRulesResolve(surface, badManifest);
    expect(result.passing).toBe(false);
    expect(
      result.entries.some(
        (e) => e.message.includes('noSuchRule') && e.message.includes('ghost-detector')
      )
    ).toBe(true);
  });

  it('marks runtime-only references pending while the fixture is absent', () => {
    const runtimeRef: RuleReference = {
      detectorId: 'runtime-detector',
      ruleName: 'unionCommand',
      appliesTo: ['runtime_fixture'],
      runtimeOnly: true,
    };
    expect(classifyApplicability(runtimeRef, 'runtime_fixture', 'skip', false)).toBe(
      'pending-runtime-fixture'
    );
    expect(classifyApplicability(runtimeRef, 'runtime_fixture', 'skip', true)).toBe('evaluate');
    // A runtime-only reference is skipped on the compiled surface.
    expect(classifyApplicability(runtimeRef, 'compiled_simplified', 'skip', false)).toBe('skip');
  });

  it('honors explicit surface exclusion', () => {
    const ref: RuleReference = {
      detectorId: 'd',
      ruleName: 'r',
      appliesTo: ['compiled_simplified'],
      excludedSurfaces: ['compiled_simplified'],
    };
    expect(classifyApplicability(ref, 'compiled_simplified', 'evaluate', false)).toBe('skip');
  });
});

describe('navigated-reference source scan (closes the manifest-omission false PASS)', () => {
  it('every rule name the detector sources navigate by literal is in the manifest', () => {
    const result = assertNavigatedReferencesCoverSource(CLASSIFICATION_MANIFEST);
    if (!result.passing) {
      throw new Error(
        result.entries
          .filter((e) => e.status === 'failure')
          .map((e) => e.message)
          .join('\n')
      );
    }
    expect(result.passing).toBe(true);
  });

  it('extracts rule-name literals from helper calls and resolver calls', () => {
    const src = `
      findAllDescendantsByRule(tree, rni, 'valueExpression');
      findChildByRule(n, rni, 'evalClause');
      const i = ruleNameToIndex('fieldExpression');
    `;
    const names = extractNavigatedRuleNames(src);
    expect(names.has('valueExpression')).toBe(true);
    expect(names.has('evalClause')).toBe(true);
    expect(names.has('fieldExpression')).toBe(true);
  });

  it('fails when a source-navigated name is missing from the manifest', () => {
    // A manifest with an empty navigated set (and empty command/dotted/alt sets)
    // must fail against the real detector sources.
    const empty: ClassificationManifest = {
      ...CLASSIFICATION_MANIFEST,
      navigatedRuleReferences: [],
      dottedPathRules: [],
      alternateSourceRules: [],
      commandRuleNames: [],
    };
    const result = assertNavigatedReferencesCoverSource(empty);
    expect(result.passing).toBe(false);
  });
});
