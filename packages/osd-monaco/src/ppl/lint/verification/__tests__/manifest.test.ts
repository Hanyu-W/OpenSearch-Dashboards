/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CLASSIFICATION_MANIFEST, ORDER_EFFECT_BY_COMMAND } from '../classification_manifest';
import { validateManifest, assertManifestImportIdentity } from '../manifest_validation';
import { PIPELINE_COMMAND_RULE_NAMES, ALTERNATE_SOURCE_SUBTREE_RULES } from '../../pipeline_shape';
import { DOTTED_PATH_RULES } from '../../rule_index';
import { ZERO_DIVISOR_OPERATORS } from '../../rules/division_by_zero';

describe('classification manifest (Property 2: shared and reviewable)', () => {
  it('exposes every manifest category', () => {
    expect(CLASSIFICATION_MANIFEST.commandRuleNames.length).toBeGreaterThan(0);
    expect(CLASSIFICATION_MANIFEST.dottedPathRules.length).toBeGreaterThan(0);
    expect(CLASSIFICATION_MANIFEST.alternateSourceRules.length).toBeGreaterThan(0);
    expect(CLASSIFICATION_MANIFEST.zeroDivisorOperators.length).toBeGreaterThan(0);
    expect(Object.keys(CLASSIFICATION_MANIFEST.orderEffectByCommand).length).toBeGreaterThan(0);
    expect(Object.keys(CLASSIFICATION_MANIFEST.tableExclusions).length).toBeGreaterThan(0);
    expect(CLASSIFICATION_MANIFEST.navigatedRuleReferences.length).toBeGreaterThan(0);
    expect(CLASSIFICATION_MANIFEST.shapeAssertions.length).toBeGreaterThan(0);
  });

  it('reads the identical hoisted constant a detector reads (import identity)', () => {
    // These are the production module constants; the manifest imports the same
    // references. A future fork of any of them fails this.
    expect(
      assertManifestImportIdentity(
        CLASSIFICATION_MANIFEST.commandRuleNames,
        PIPELINE_COMMAND_RULE_NAMES,
        'commandRuleNames'
      ).passing
    ).toBe(true);
    expect(
      assertManifestImportIdentity(
        CLASSIFICATION_MANIFEST.dottedPathRules,
        DOTTED_PATH_RULES,
        'dottedPathRules'
      ).passing
    ).toBe(true);
    expect(
      assertManifestImportIdentity(
        CLASSIFICATION_MANIFEST.alternateSourceRules,
        ALTERNATE_SOURCE_SUBTREE_RULES,
        'alternateSourceRules'
      ).passing
    ).toBe(true);
    expect(
      assertManifestImportIdentity(
        CLASSIFICATION_MANIFEST.zeroDivisorOperators,
        ZERO_DIVISOR_OPERATORS,
        'zeroDivisorOperators'
      ).passing
    ).toBe(true);
  });

  it('keeps the zero-divisor operator set as exactly [/]', () => {
    expect([...CLASSIFICATION_MANIFEST.zeroDivisorOperators]).toEqual(['/']);
  });

  it('marks order-effect entries as added semantics with reasons', () => {
    for (const [command, decision] of Object.entries(ORDER_EFFECT_BY_COMMAND)) {
      expect(decision.orderEffect).toBeDefined();
      expect((decision.reason ?? '').trim().length).toBeGreaterThan(0);
      expect(decision.commandRuleName).toBe(command);
    }
  });

  it('validates the manifest structural invariants', () => {
    const result = validateManifest(CLASSIFICATION_MANIFEST);
    expect(result.passing).toBe(true);
  });

  it('fails validation when the zero-divisor set is expanded without evidence', () => {
    const tampered = { ...CLASSIFICATION_MANIFEST, zeroDivisorOperators: ['/', '%'] };
    expect(validateManifest(tampered).passing).toBe(false);
  });

  it('fails validation when an excluded decision lacks a reason', () => {
    const tampered = {
      ...CLASSIFICATION_MANIFEST,
      tableExclusions: {
        bad: [{ commandRuleName: 'x', decision: 'excluded' as const }],
      },
    };
    expect(validateManifest(tampered).passing).toBe(false);
  });

  it('detects a forked import-identity value', () => {
    expect(assertManifestImportIdentity(['a'], ['b'], 'commandRuleNames').passing).toBe(false);
  });
});
