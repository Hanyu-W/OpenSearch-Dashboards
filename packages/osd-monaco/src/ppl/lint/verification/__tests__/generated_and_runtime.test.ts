/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { compiledSimplifiedSurface, resetSurfaceCache } from '../grammar_surface';
import {
  generateDescriptorCases,
  processGeneratedCase,
  assertRandomizedDependencyApproved,
  NO_THROW_BOUNDS,
} from '../generated_cases';
import {
  setupRuntimeFixture,
  isRuntimeSetupUnavailable,
  RuntimeGrammarFixture,
} from '../runtime_grammar_fixture';

describe('Generated coverage (Property 13: bounded, cannot hide gaps)', () => {
  beforeEach(resetSurfaceCache);

  it('every descriptor-generated case reparses and lints without throwing', () => {
    const surface = compiledSimplifiedSurface();
    for (const generated of generateDescriptorCases(surface)) {
      const result = processGeneratedCase(generated, surface);
      if (!result.passing) {
        throw new Error(`${generated.caseId}: ` + result.entries.map((e) => e.message).join('; '));
      }
      expect(result.passing).toBe(true);
    }
  });

  it('reports a generation gap when a generated query cannot reparse', () => {
    const surface = compiledSimplifiedSurface();
    // A surface whose parse always throws simulates an unreparseable query.
    const brokenSurface = {
      ...surface,
      parse: () => {
        throw new Error('boom');
      },
    };
    const result = processGeneratedCase(
      {
        caseId: 'gap',
        query: 'garbage',
        surfaceName: 'compiled_simplified',
        generationSeed: 'seed:gap',
        recursionDepth: 1,
        tokenCount: 1,
        transitionTraversals: 0,
        usableForDetectorAssertions: true,
      },
      brokenSurface
    );
    expect(result.passing).toBe(false);
    expect(result.entries[0].message).toContain('Generation gap');
    expect(result.entries[0].context.query).toBe('garbage');
  });

  it('fails a case that exceeds no-throw bounds', () => {
    const surface = compiledSimplifiedSurface();
    const result = processGeneratedCase(
      {
        caseId: 'too-deep',
        query: 'source=t | head 1',
        surfaceName: 'compiled_simplified',
        generationSeed: 'seed:deep',
        recursionDepth: NO_THROW_BOUNDS.maxRecursionLevels + 1,
        tokenCount: 1,
        transitionTraversals: 0,
        usableForDetectorAssertions: false,
      },
      surface
    );
    expect(result.passing).toBe(false);
    expect(result.entries[0].message).toContain('no-throw bounds');
  });

  it('guards a future randomized dependency to pinned + reviewed', () => {
    expect(assertRandomizedDependencyApproved().passing).toBe(true);
    expect(
      assertRandomizedDependencyApproved({
        name: 'fast-check',
        version: '^3.0.0',
        reviewApproved: true,
      }).passing
    ).toBe(false);
    expect(
      assertRandomizedDependencyApproved({
        name: 'fast-check',
        version: '3.0.0',
        reviewApproved: false,
      }).passing
    ).toBe(false);
    expect(
      assertRandomizedDependencyApproved({
        name: 'fast-check',
        version: '3.0.0',
        reviewApproved: true,
      }).passing
    ).toBe(true);
  });
});

describe('RuntimeGrammarFixture (Property 12: provenance + freshness)', () => {
  it('reports pending when the fixture is absent', () => {
    const result = setupRuntimeFixture(undefined);
    expect(isRuntimeSetupUnavailable(result)).toBe(true);
    if (isRuntimeSetupUnavailable(result)) {
      expect(result.pending).toBe(true);
    }
  });

  it('fails setup (not pending) when metadata is incomplete', () => {
    const incomplete = ({
      engineVersion: '',
      sourceModule: 'x',
    } as unknown) as RuntimeGrammarFixture;
    const result = setupRuntimeFixture(incomplete);
    expect(isRuntimeSetupUnavailable(result)).toBe(true);
    if (isRuntimeSetupUnavailable(result)) {
      expect(result.pending).toBe(false);
      expect(result.message).toContain('incomplete');
    }
  });

  it('fails setup on a hash mismatch', () => {
    const fixture = minimalFixture();
    const result = setupRuntimeFixture(fixture, { expectedHash: 'sha256:different' });
    expect(isRuntimeSetupUnavailable(result)).toBe(true);
    if (isRuntimeSetupUnavailable(result)) {
      expect(result.message).toContain('hash');
    }
  });

  it('fails setup when the source-freshness check fails', () => {
    const fixture = minimalFixture();
    const result = setupRuntimeFixture(fixture, {
      runSourceFreshnessCheck: () => ({ ok: false, importPath: 'target/stale.js' }),
    });
    expect(isRuntimeSetupUnavailable(result)).toBe(true);
    if (isRuntimeSetupUnavailable(result)) {
      expect(result.message).toContain('Stale runtime import');
    }
  });
});

/** A structurally-complete but ATN-invalid fixture — enough to exercise the
 *  metadata/hash/freshness gates without a real serialized grammar. */
function minimalFixture(): RuntimeGrammarFixture {
  return {
    engineVersion: '3.7.0',
    sourceModule: 'test',
    grammarProvenance: 'test-fixture',
    grammarHash: 'sha256:test',
    lexerSerializedATN: [1],
    parserSerializedATN: [1],
    lexerRuleNames: ['A'],
    parserRuleNames: ['root'],
    channelNames: ['DEFAULT_TOKEN_CHANNEL'],
    modeNames: ['DEFAULT_MODE'],
    literalNames: [null],
    symbolicNames: [null, 'A'],
    startRuleIndex: 0,
  };
}
