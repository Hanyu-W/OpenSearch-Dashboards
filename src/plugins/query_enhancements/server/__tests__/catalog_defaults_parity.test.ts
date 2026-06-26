/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PPL_LINT_RULE_DEFAULTS } from '../ui_settings';

/**
 * Option 1, Layer A — the catalog↔defaults parity check.
 *
 * `PPL_LINT_RULE_DEFAULTS` (in `ui_settings.ts`) is the list query_enhancements
 * registers a per-rule uiSettings toggle from. A rule that ships in
 * `@osd/monaco`'s bundled catalog but is missing here has *no* toggle key, so it
 * can never be disabled or have its severity changed from Advanced Settings — the
 * recurring "added a detector + a catalog entry but forgot the third edit"
 * footgun (see ppl-lint-rule-registration-parity). The reverse — a default with
 * no catalog entry — registers a dead toggle key for a rule that does not exist.
 *
 * This asserts the two lists are 1:1 (by id) and agree on `enabled`/`severity`,
 * directly on the exported const rather than through `getPplLintRuleSettings`,
 * so the invariant holds even if that registration helper is refactored.
 *
 * The catalog is read from JSON at runtime (not `import`-ed) for the same reason
 * `ui_settings.test.ts` does: query_enhancements cannot import `@osd/monaco`
 * server-side (jest mocks the barrel globally, and the built `target/` can lag
 * the source), and a cross-package relative import into `packages/osd-monaco/src`
 * escapes this project's TS rootDir. A plain file read sidesteps both.
 */
interface BundledRule {
  id: string;
  detector: string;
  enabled: boolean;
  severity: 'error' | 'warning' | 'info';
}

const CATALOG_PATH = resolve(
  __dirname,
  '../../../../../packages/osd-monaco/src/ppl/lint/rules_catalog.json'
);

const bundledCatalog: BundledRule[] = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

describe('PPL lint catalog ↔ PPL_LINT_RULE_DEFAULTS parity (Option 1, Layer A)', () => {
  const catalogById = new Map(bundledCatalog.map((rule) => [rule.id, rule]));
  const defaultsById = new Map(PPL_LINT_RULE_DEFAULTS.map((rule) => [rule.id, rule]));

  it('registers a per-rule default for every catalog rule (no untoggleable rule)', () => {
    const missing = bundledCatalog.map((r) => r.id).filter((id) => !defaultsById.has(id));
    expect(missing).toEqual([]);
  });

  it('has no default for a rule absent from the catalog (no dead toggle key)', () => {
    const orphan = PPL_LINT_RULE_DEFAULTS.map((r) => r.id).filter((id) => !catalogById.has(id));
    expect(orphan).toEqual([]);
  });

  it('keeps the two lists the same length (1:1, no duplicates)', () => {
    expect(PPL_LINT_RULE_DEFAULTS).toHaveLength(bundledCatalog.length);
    // No duplicate ids on either side.
    expect(defaultsById.size).toBe(PPL_LINT_RULE_DEFAULTS.length);
    expect(catalogById.size).toBe(bundledCatalog.length);
  });

  it("mirrors each catalog rule's enabled/severity in its registered default", () => {
    for (const rule of bundledCatalog) {
      const def = defaultsById.get(rule.id);
      expect(def).toBeDefined();
      expect({ enabled: def!.enabled, severity: def!.severity }).toEqual({
        enabled: rule.enabled,
        severity: rule.severity,
      });
    }
  });
});
