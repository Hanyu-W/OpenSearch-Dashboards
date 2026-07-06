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

describe('GrammarCommandInventory (Property 3: complete, traceable, compared)', () => {
  beforeEach(() => {
    resetInventoryCache();
    resetSurfaceCache();
  });

  it('collects exactly the *Command suffix rules per surface', () => {
    const compiled = deriveCommandInventory(compiledSimplifiedSurface());
    // Every collected rule ends in Command; the count matches the grammar.
    for (const rule of compiled.commandRules) {
      expect(rule.endsWith('Command')).toBe(true);
    }
    expect(compiled.commandRules.size).toBe(35);

    const proxy = deriveCommandInventory(inRepoFullProxySurface());
    expect(proxy.commandRules.size).toBe(19);
    // The proxy command set is a strict subset of the compiled one.
    for (const rule of proxy.commandRules) {
      expect(compiled.commandRules.has(rule)).toBe(true);
    }
  });

  it('labels every derived item with surface and provenance', () => {
    const inv = deriveCommandInventory(compiledSimplifiedSurface());
    expect(inv.surfaceName).toBe('compiled_simplified');
    expect(inv.provenance).toContain('SimplifiedOpenSearchPPLParser');
  });

  it('derives command-start tokens from FIRST(commands) with no warnings', () => {
    const inv = deriveCommandInventory(compiledSimplifiedSurface());
    expect(inv.commandStartTokens.size).toBeGreaterThan(0);
    expect(inv.commandStartTokens.has('where')).toBe(true);
    expect(inv.commandStartTokens.has('sort')).toBe(true);
    expect(inv.derivationWarnings).toHaveLength(0);
  });

  it('produces derivation-path comparisons', () => {
    const inv = deriveCommandInventory(compiledSimplifiedSurface());
    expect(inv.comparisonResults.length).toBeGreaterThan(0);
    // None should be flagged unexpected on the shipping surface.
    expect(inv.comparisonResults.filter((c) => c.unexpected)).toHaveLength(0);
  });

  it('caches per-surface derivation within a run', () => {
    const surface = compiledSimplifiedSurface();
    const first = deriveCommandInventory(surface);
    const second = deriveCommandInventory(surface);
    expect(first).toBe(second); // referential identity from the cache
  });

  it('records a warning when the commands rule is absent', () => {
    const surface = compiledSimplifiedSurface();
    const fakeSurface = {
      ...surface,
      name: 'compiled_simplified' as const,
      getRuleIndex: (n: string) => (n === 'commands' ? -1 : surface.getRuleIndex(n)),
    };
    resetInventoryCache();
    const inv = deriveCommandInventory(fakeSurface);
    expect(inv.derivationWarnings.some((w) => w.message.includes('commands'))).toBe(true);
  });
});
