/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { runFastLaneVerification } from '../run_verification';
import { FAST_LANE_REQUIRED_CATEGORIES } from '../types';
import { reportPasses, formatVerificationFailures } from '../report';
import { resetInventoryCache } from '../grammar_command_inventory';
import { resetSurfaceCache } from '../grammar_surface';

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
});
