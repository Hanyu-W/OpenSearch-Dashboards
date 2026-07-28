/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ParserRuleContext } from 'antlr4ng';
import { runLint } from '../lint_runner';
import { registerDetector, resetDetectorRegistry } from '../detector_registry';
import { CatalogEntry } from '../types';

const fakeTree = ({} as unknown) as ParserRuleContext;
const rni = () => -1;

function makeRule(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: 'r',
    detector: 'r',
    enabled: true,
    severity: 'error',
    message: 'm',
    howToFix: 'fix',
    docUrl: 'd',
    appliesTo: {},
    ...overrides,
  };
}

describe('runLint resolution loop', () => {
  afterEach(() => {
    resetDetectorRegistry();
  });

  it('isolates a throwing detector and still runs the rest', () => {
    registerDetector('throws', () => {
      throw new Error('boom');
    });
    registerDetector('ok', (_t, cfg) => [
      {
        ruleId: cfg.id,
        severity: cfg.severity,
        message: 'ok',
        range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
      },
    ]);

    const catalog = [
      makeRule({ id: 'a', detector: 'throws' }),
      makeRule({ id: 'b', detector: 'ok' }),
    ];

    const diags = runLint(fakeTree, { catalog, ruleNameToIndex: rni, context: {} });
    expect(diags.map((d) => d.ruleId)).toEqual(['b']);
  });

  it('skips disabled rules', () => {
    registerDetector('ok', (_t, cfg) => [
      {
        ruleId: cfg.id,
        severity: cfg.severity,
        message: 'ok',
        range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
      },
    ]);
    const catalog = [makeRule({ id: 'a', detector: 'ok', enabled: false })];
    expect(runLint(fakeTree, { catalog, ruleNameToIndex: rni, context: {} })).toEqual([]);
  });

  it('skips a rule whose detector is unregistered (inert)', () => {
    const catalog = [makeRule({ id: 'a', detector: 'missing-detector' })];
    expect(runLint(fakeTree, { catalog, ruleNameToIndex: rni, context: {} })).toEqual([]);
  });

  it('gates needsContext rules only when all context resources are empty', () => {
    registerDetector('ctx', (_t, cfg) => [
      {
        ruleId: cfg.id,
        severity: cfg.severity,
        message: 'x',
        range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
      },
    ]);
    const catalog = [makeRule({ id: 'a', detector: 'ctx', needsContext: true })];

    expect(runLint(fakeTree, { catalog, ruleNameToIndex: rni, context: {} })).toEqual([]);
    expect(runLint(fakeTree, { catalog, ruleNameToIndex: rni })).toEqual([]);
    expect(
      runLint(fakeTree, {
        catalog,
        ruleNameToIndex: rni,
        context: {
          fields: new Set(),
          typeMap: new Map(),
          disabledObjectFields: new Set(),
          visibleIndices: [],
        },
      })
    ).toEqual([]);

    for (const context of [
      { fields: new Set(['f']) },
      { typeMap: new Map([['f', 'long']]) },
      { disabledObjectFields: new Set(['raw']) },
      { visibleIndices: ['logs-2026'] },
    ]) {
      expect(runLint(fakeTree, { catalog, ruleNameToIndex: rni, context })).toHaveLength(1);
    }
  });

  it('applies bundle overrides over local config', () => {
    registerDetector('ok', (_t, cfg) => [
      {
        ruleId: cfg.id,
        severity: cfg.severity,
        message: cfg.message,
        range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
      },
    ]);
    const catalog = [makeRule({ id: 'a', detector: 'ok', enabled: true })];

    // Bundle disables the rule.
    expect(
      runLint(fakeTree, {
        catalog,
        ruleNameToIndex: rni,
        context: {},
        bundleOverrides: { a: { enabled: false } },
      })
    ).toEqual([]);
  });
});
