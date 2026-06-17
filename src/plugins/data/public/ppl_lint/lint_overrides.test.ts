/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { IUiSettingsClient } from 'opensearch-dashboards/public';
import { buildOverridesFromSettings } from './lint_overrides';

// The global monaco mock only provides { monaco, getWorker }; this helper needs
// getBundledCatalog, so mock @osd/monaco locally with a small representative
// catalog. Includes a silent-failure rule (division-by-zero) to exercise the
// severity floor, and a plain info rule (head-without-sort) to exercise muting.
jest.mock('@osd/monaco', () => ({
  getBundledCatalog: () => [
    { id: 'head-without-sort', enabled: true, severity: 'info' },
    { id: 'division-by-zero', enabled: true, severity: 'warning' },
    { id: 'field-validation', enabled: true, severity: 'warning' },
  ],
}));

function makeUiSettings(stored: Record<string, unknown>): IUiSettingsClient {
  return ({
    get: (key: string, defaultOverride?: unknown) =>
      key in stored ? stored[key] : defaultOverride,
  } as unknown) as IUiSettingsClient;
}

const PREFIX = 'query:enhancements:pplLint:rule:';

describe('buildOverridesFromSettings', () => {
  it('returns an empty map when nothing is stored (sparse)', () => {
    const overrides = buildOverridesFromSettings(makeUiSettings({}));
    expect(overrides).toEqual({});
  });

  it('omits a stored value that equals the bundled default', () => {
    const overrides = buildOverridesFromSettings(
      makeUiSettings({
        [`${PREFIX}head-without-sort`]: { enabled: true, severity: 'info' },
      })
    );
    expect(overrides).toEqual({});
  });

  it('emits only the field that differs from the default', () => {
    const overrides = buildOverridesFromSettings(
      makeUiSettings({
        [`${PREFIX}head-without-sort`]: { enabled: false, severity: 'info' },
      })
    );
    expect(overrides).toEqual({ 'head-without-sort': { enabled: false } });
  });

  it('passes through an allowed severity change', () => {
    const overrides = buildOverridesFromSettings(
      makeUiSettings({
        [`${PREFIX}head-without-sort`]: { enabled: true, severity: 'error' },
      })
    );
    expect(overrides).toEqual({ 'head-without-sort': { severity: 'error' } });
  });

  it('clamps a silent-failure rule up to its severity floor', () => {
    // A user tries to downgrade division-by-zero to info; the floor is warning.
    const overrides = buildOverridesFromSettings(
      makeUiSettings({
        [`${PREFIX}division-by-zero`]: { enabled: true, severity: 'info' },
      })
    );
    // Clamped to warning — which equals the catalog default, so it is dropped.
    expect(overrides).toEqual({});
  });

  it('still allows disabling a silent-failure rule (floor only clamps severity)', () => {
    const overrides = buildOverridesFromSettings(
      makeUiSettings({
        [`${PREFIX}division-by-zero`]: { enabled: false, severity: 'info' },
      })
    );
    // enabled:false is honored; severity clamps to the floor (== default, dropped).
    expect(overrides).toEqual({ 'division-by-zero': { enabled: false } });
  });

  it('clamps a downgrade but keeps a value at-or-above the floor', () => {
    // Floor is warning; raising to error is allowed and differs from default.
    const overrides = buildOverridesFromSettings(
      makeUiSettings({
        [`${PREFIX}division-by-zero`]: { enabled: true, severity: 'error' },
      })
    );
    expect(overrides).toEqual({ 'division-by-zero': { severity: 'error' } });
  });

  it('combines enabled + severity changes for a non-floored rule', () => {
    const overrides = buildOverridesFromSettings(
      makeUiSettings({
        [`${PREFIX}field-validation`]: { enabled: false, severity: 'error' },
      })
    );
    expect(overrides).toEqual({
      'field-validation': { enabled: false, severity: 'error' },
    });
  });
});
