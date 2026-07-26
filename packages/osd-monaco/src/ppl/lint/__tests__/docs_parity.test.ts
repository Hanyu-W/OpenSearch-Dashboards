/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keeps the linter's documentation mechanically in sync with the code:
 *
 *  1. Every catalog rule has exactly one page in docs/rules/ (matched by the
 *     `rule:` frontmatter field, not the filename) and vice versa.
 *  2. Every page answers the five required questions.
 *  3. The generated rules table in README.md matches the catalog joined with
 *     the shipped uiSettings defaults — the catalog marks every rule
 *     `enabled: true`, but PPL_LINT_RULE_DEFAULTS (query_enhancements) is the
 *     layer that decides the effective default, so the table must reflect
 *     that join, not the catalog alone.
 *
 * The uiSettings defaults live across the package boundary in
 * src/plugins/query_enhancements/server/ui_settings.ts, which this package
 * cannot import; the test reads that file as text instead so the check stays
 * anchored to the real shipped values.
 */

import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { getBundledCatalog } from '../catalog';

const DOCS_RULES_DIR = resolve(__dirname, '../docs/rules');
const README_PATH = resolve(__dirname, '../README.md');
const UI_SETTINGS_PATH = resolve(
  __dirname,
  '../../../../../../src/plugins/query_enhancements/server/ui_settings.ts'
);

const REQUIRED_SECTIONS = [
  '**What it detects.**',
  '**Why it matters.**',
  '**Example.**',
  '**How to fix it.**',
  '**Availability.**',
];

interface DocPage {
  file: string;
  ruleId: string;
  body: string;
}

function loadDocPages(): DocPage[] {
  return readdirSync(DOCS_RULES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const body = readFileSync(resolve(DOCS_RULES_DIR, file), 'utf8');
      const match = body.match(/^---\n(?:.*\n)*?rule:\s*(\S+)\n(?:.*\n)*?---/);
      return { file, ruleId: match ? match[1] : '', body };
    });
}

/** The effective shipped default per rule id: catalog overridden by uiSettings. */
function loadEffectiveDefaults(): Map<string, { enabled: boolean; severity: string }> {
  const source = readFileSync(UI_SETTINGS_PATH, 'utf8');
  const entryRe = /\{\s*id:\s*'([^']+)',\s*enabled:\s*(true|false),\s*severity:\s*'([^']+)'\s*\}/g;
  const defaults = new Map<string, { enabled: boolean; severity: string }>();
  let m = entryRe.exec(source);
  while (m) {
    defaults.set(m[1], { enabled: m[2] === 'true', severity: m[3] });
    m = entryRe.exec(source);
  }
  return defaults;
}

describe('lint docs parity', () => {
  const catalog = getBundledCatalog();
  const pages = loadDocPages();

  it('has exactly one doc page per catalog rule', () => {
    const catalogIds = catalog.map((r) => r.id).sort();
    const pageIds = pages.map((p) => p.ruleId).sort();
    expect(pageIds).toEqual(catalogIds);
  });

  it('every doc page declares a rule id in frontmatter', () => {
    const missing = pages.filter((p) => !p.ruleId).map((p) => p.file);
    expect(missing).toEqual([]);
  });

  it.each(loadDocPages().map((p) => [p.file, p] as const))(
    '%s answers the five required questions',
    (_file, page) => {
      const missing = REQUIRED_SECTIONS.filter((section) => !page.body.includes(section));
      expect(missing).toEqual([]);
    }
  );

  describe('uiSettings defaults join', () => {
    const defaults = loadEffectiveDefaults();

    it('registers a shipped default for every catalog rule (and no extras)', () => {
      expect(Array.from(defaults.keys()).sort()).toEqual(catalog.map((r) => r.id).sort());
    });

    it('uiSettings severity always mirrors the catalog', () => {
      const drift = catalog
        .filter((r) => defaults.get(r.id)?.severity !== r.severity)
        .map((r) => r.id);
      expect(drift).toEqual([]);
    });

    it('off-by-default rules say so in their doc page', () => {
      const offRules = catalog.filter((r) => defaults.get(r.id)?.enabled === false);
      // Sanity: the shipped opt-in set. Update this list (and the doc pages,
      // and the README table) when a rule's default flips.
      expect(offRules.map((r) => r.id).sort()).toEqual([
        'operation-not-pushed',
        'operation-pushed-as-script',
        'rex-scan-cost',
      ]);
      for (const rule of offRules) {
        const page = pages.find((p) => p.ruleId === rule.id);
        expect(page?.body).toContain('off by default');
      }
    });
  });

  describe('README generated rules table', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const tableMatch = readme.match(
      /<!-- BEGIN GENERATED RULES TABLE -->\n([\s\S]*?)<!-- END GENERATED RULES TABLE -->/
    );
    const rows = new Map<string, { severity: string; defaultState: string }>();
    if (tableMatch) {
      for (const line of tableMatch[1].split('\n')) {
        const row = line.match(/^\| `([^`]+)` \| (\w+) \| (\w+) \|/);
        if (row) rows.set(row[1], { severity: row[2], defaultState: row[3] });
      }
    }

    it('exists between the generated markers', () => {
      expect(tableMatch).not.toBeNull();
    });

    it('lists every catalog rule and nothing else', () => {
      expect(Array.from(rows.keys()).sort()).toEqual(catalog.map((r) => r.id).sort());
    });

    it('severity and effective default match the catalog ⋈ uiSettings join', () => {
      const defaults = loadEffectiveDefaults();
      const drift = catalog
        .filter((r) => {
          const row = rows.get(r.id);
          const expected = defaults.get(r.id)?.enabled === false ? 'off' : 'on';
          return !row || row.severity !== r.severity || row.defaultState !== expected;
        })
        .map((r) => r.id);
      expect(drift).toEqual([]);
    });
  });
});
