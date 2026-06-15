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
    docUrl: 'd',
    appliesTo: {},
    ...overrides,
  };
}

// A detector that echoes the resolved config so we can assert on the merge.
function registerEcho(name: string) {
  registerDetector(name, (_t, cfg) => [
    {
      ruleId: cfg.id,
      severity: cfg.severity,
      message: cfg.message,
      range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
    },
  ]);
}

describe('runLint — per-rule overrides threaded through context', () => {
  afterEach(() => {
    resetDetectorRegistry();
  });

  it('disables a rule via context.overrides', () => {
    registerEcho('ok');
    const catalog = [makeRule({ id: 'a', detector: 'ok', enabled: true })];

    expect(
      runLint(fakeTree, {
        catalog,
        ruleNameToIndex: rni,
        context: { overrides: { a: { enabled: false } } },
      })
    ).toEqual([]);
  });

  it('changes severity via context.overrides', () => {
    registerEcho('ok');
    const catalog = [makeRule({ id: 'a', detector: 'ok', severity: 'info' })];

    const diags = runLint(fakeTree, {
      catalog,
      ruleNameToIndex: rni,
      context: { overrides: { a: { severity: 'error' } } },
    });

    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
  });

  it('only touches the targeted rule; others keep catalog config', () => {
    registerEcho('ok');
    const catalog = [
      makeRule({ id: 'a', detector: 'ok', severity: 'info' }),
      makeRule({ id: 'b', detector: 'ok', severity: 'warning' }),
    ];

    const diags = runLint(fakeTree, {
      catalog,
      ruleNameToIndex: rni,
      context: { overrides: { a: { severity: 'error' } } },
    });

    const bySeverity = Object.fromEntries(diags.map((d) => [d.ruleId, d.severity]));
    expect(bySeverity).toEqual({ a: 'error', b: 'warning' });
  });

  it('lets an explicit bundleOverrides arg win over context.overrides', () => {
    registerEcho('ok');
    const catalog = [makeRule({ id: 'a', detector: 'ok', severity: 'info' })];

    // bundleOverrides (the runtime-bundle path) takes precedence; context is ignored.
    const diags = runLint(fakeTree, {
      catalog,
      ruleNameToIndex: rni,
      bundleOverrides: { a: { severity: 'warning' } },
      context: { overrides: { a: { severity: 'error' } } },
    });

    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
  });

  it('is a no-op when context carries no overrides (catalog severity preserved)', () => {
    registerEcho('ok');
    const catalog = [makeRule({ id: 'a', detector: 'ok', severity: 'warning' })];

    const diags = runLint(fakeTree, { catalog, ruleNameToIndex: rni, context: {} });
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
  });
});
