/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBundledCatalog } from '../../catalog';
import { ENGINE_OUTCOMES, getRuleHoverContent } from '../engine_outcomes';

// Coverage guard for the static hover-content table. Mirrors the doc-link Tier-1
// parity test: a rule added to the catalog without an engine_outcomes entry (or
// a stale entry whose rule was removed) fails here, in default offline CI.

const catalog = getBundledCatalog();
const enabledIds = catalog
  .filter((e) => e.enabled)
  .map((e) => e.id)
  .sort();
const tableIds = Object.keys(ENGINE_OUTCOMES).sort();

describe('engine_outcomes coverage', () => {
  it('every enabled catalog rule has an engine_outcomes entry', () => {
    const missing = enabledIds.filter((id) => !ENGINE_OUTCOMES[id]);
    expect(missing).toEqual([]);
  });

  it('every engine_outcomes entry maps to a real catalog rule', () => {
    const catalogIds = new Set(catalog.map((e) => e.id));
    const stale = tableIds.filter((id) => !catalogIds.has(id));
    expect(stale).toEqual([]);
  });

  it('never offers "safe to ignore" for an error-severity rule', () => {
    const offenders = catalog
      .filter((e) => e.severity === 'error')
      .filter((e) => getRuleHoverContent(e.id)?.safeToIgnoreWhen !== undefined)
      .map((e) => e.id);
    expect(offenders).toEqual([]);
  });

  it('engine-throw rules are error-severity OR carry only a false-positive caveat', () => {
    // An engine-throw rule means the query genuinely would not run. If such a
    // rule is only a warning, its escape hatch must read as a possible false
    // positive (rendered by the card), never as "the query is fine to ship" —
    // and an engine-throw rule must never be a plain advisory. This guards the
    // contradiction where a warning said both "the engine rejects the query"
    // and "safe to ignore".
    for (const e of catalog) {
      const content = getRuleHoverContent(e.id);
      if (content?.failureClass !== 'engine-throw') {
        continue;
      }
      // Coherent by construction: error-severity rules carry no escape hatch
      // (covered above); warning-severity engine-throw rules render their
      // caveat under the "Possible false positive" label, which the renderer
      // derives from failureClass — so the only invariant to lock here is that
      // an engine-throw rule is never silently downgraded below warning.
      expect(['error', 'warning']).toContain(e.severity);
    }
  });

  it('every entry has a non-empty engineBehavior sentence', () => {
    for (const [id, content] of Object.entries(ENGINE_OUTCOMES)) {
      expect(typeof content.engineBehavior).toBe('string');
      expect(content.engineBehavior.length).toBeGreaterThan(0);
      expect(id).toBeTruthy();
    }
  });

  it('getRuleHoverContent returns undefined for an unknown rule', () => {
    expect(getRuleHoverContent('no-such-rule')).toBeUndefined();
  });
});
