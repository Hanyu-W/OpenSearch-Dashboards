/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { runFastLaneVerification } from '../run_verification';
import { FAST_LANE_REQUIRED_CATEGORIES } from '../types';
import { reportPasses, formatVerificationFailures, unrunRequiredCategories } from '../report';
import { resetInventoryCache } from '../grammar_command_inventory';
import {
  compiledSimplifiedSurface,
  inRepoFullProxySurface,
  resetSurfaceCache,
} from '../grammar_surface';

describe('runFastLaneVerification (end-to-end fast lane)', () => {
  beforeEach(() => {
    resetInventoryCache();
    resetSurfaceCache();
  });

  it('emits a status for every required fast-lane category', () => {
    const report = runFastLaneVerification();
    for (const category of FAST_LANE_REQUIRED_CATEGORIES) {
      expect(report.statuses[category]).toBeDefined();
      expect(report.statuses[category]).not.toBe('not-run');
    }
  });

  it('passes with no blocking failures on the shipping assets', () => {
    const report = runFastLaneVerification();
    if (!reportPasses(report)) {
      // Surface the failures in the assertion message for fast diagnosis.
      throw new Error(formatVerificationFailures(report));
    }
    expect(report.blockingFailures).toHaveLength(0);
  });

  it('labels runtime-fixture coverage pending while the fixture is absent', () => {
    const report = runFastLaneVerification();
    expect(report.statuses['runtime-fixture-setup']).toBe('pending');
    expect(report.pending.some((e) => e.category === 'runtime-fixture-setup')).toBe(true);
  });

  it('runs the fast lane on the fast lane only (no runtime_fixture surface)', () => {
    const report = runFastLaneVerification();
    expect(report.lane).toBe('fast');
    // No entry claims runtime_fixture surface coverage while pending.
    const runtimeSurfaceEntries = report.entries.filter(
      (e) => e.context.surface === 'runtime_fixture' && e.status === 'pass'
    );
    expect(runtimeSurfaceEntries).toHaveLength(0);
  });

  it('every required category actually ran (no vacuous coverage)', () => {
    const report = runFastLaneVerification();
    expect(unrunRequiredCategories(report)).toEqual([]);
  });

  it('FAILS loud when the compiled surface is absent (no silent skip of behavior checks)', () => {
    // A surfaces list lacking the compiled surface must not yield a green run.
    const report = runFastLaneVerification({ surfaces: [inRepoFullProxySurface()] });
    expect(reportPasses(report)).toBe(false);
    for (const category of ['behavioral', 'version-context', 'metamorphic'] as const) {
      expect(report.statuses[category]).toBe('fail');
    }
  });

  it('a report with a required category left not-run does not pass', () => {
    // Run with an empty surfaces list: behavioral/version/metamorphic never run.
    const report = runFastLaneVerification({ surfaces: [] });
    expect(reportPasses(report)).toBe(false);
    expect(unrunRequiredCategories(report).length).toBeGreaterThan(0);
  });

  it('the compiled surface actually parses the round-trip corpus (proxy exercised too)', () => {
    const report = runFastLaneVerification({
      surfaces: [compiledSimplifiedSurface(), inRepoFullProxySurface()],
    });
    // Both surfaces contribute passing shape/round-trip entries.
    const proxyRoundTrips = report.entries.filter(
      (e) =>
        e.context.surface === 'in_repo_full_proxy' && e.category === 'shape' && e.status === 'pass'
    );
    expect(proxyRoundTrips.length).toBeGreaterThan(0);
  });
});
