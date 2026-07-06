/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { ClassificationManifest, VerificationResult } from './types';

/**
 * Statically scans the shipping detector sources for the grammar rule names they
 * resolve dynamically, and cross-checks them against the manifest's
 * `navigatedRuleReferences`. This closes a false-PASS: a rule name a detector
 * navigates but that is MISSING from the manifest would silently no-op in
 * production (resolve to -1) while the silent-no-op guard — which only iterates
 * the manifest — reports PASS. Here, a navigated name found in source but absent
 * from the manifest is a blocking failure (R5.1, R5.5).
 *
 * This is a Node/Jest-only check (reads source files); it never runs in the
 * browser lint path.
 */

/** The lint dir root, relative to this file (…/verification → …/lint). */
const LINT_DIR = path.resolve(__dirname, '..');

/** Source files the detectors and shared navigation helpers live in. */
function detectorSourceFiles(): string[] {
  const files: string[] = [];
  const rulesDir = path.join(LINT_DIR, 'rules');
  if (fs.existsSync(rulesDir)) {
    for (const name of fs.readdirSync(rulesDir)) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        files.push(path.join(rulesDir, name));
      }
    }
  }
  // Shared navigation helpers also resolve rule names by literal.
  for (const shared of ['pipeline_shape.ts']) {
    const p = path.join(LINT_DIR, shared);
    if (fs.existsSync(p)) {
      files.push(p);
    }
  }
  return files;
}

/**
 * Extract rule-name string literals passed to the by-name navigation helpers or
 * resolvers. Matches:
 *   findChildByRule(x, y, 'ruleName')
 *   findAllChildrenByRule(x, y, 'ruleName')
 *   findAllDescendantsByRule(x, y, 'ruleName')
 *   ruleNameToIndex('ruleName')
 * The rule name is always the last single-quoted argument of the call.
 */
export function extractNavigatedRuleNames(source: string): Set<string> {
  const names = new Set<string>();

  const helperRe = /find(?:Child|AllChildren|AllDescendants)ByRule\([^)]*?'([A-Za-z][A-Za-z0-9]*)'\s*\)/g;
  const resolverRe = /ruleNameToIndex\(\s*'([A-Za-z][A-Za-z0-9]*)'\s*\)/g;

  for (const re of [helperRe, resolverRe]) {
    let match: RegExpExecArray | null;

    while ((match = re.exec(source)) !== null) {
      names.add(match[1]);
    }
  }
  return names;
}

/**
 * Rule names that legitimately appear in detector source but are not part of the
 * manifest's per-detector navigated set, because they are resolved through a
 * shared helper the manifest already accounts for under a different detector, or
 * are hoisted constants the census covers separately. Kept small and explicit.
 */
const SCAN_EXEMPT_RULE_NAMES: ReadonlySet<string> = new Set<string>([
  // Resolved inside pipeline_shape's shared created-field / stage scan, which is
  // exercised by the shape assertions and the pipeline command census, not the
  // per-detector navigated list.
  'evalClause',
  'fieldExpression',
  'stringLiteral',
  'spathParameter',
  'indexablePath',
]);

/**
 * Cross-check: every rule name a detector source navigates by literal is present
 * in the manifest's navigatedRuleReferences (or explicitly exempt). A missing
 * one is a blocking failure — it would silently no-op in production.
 */
export function assertNavigatedReferencesCoverSource(
  manifest: ClassificationManifest
): VerificationResult {
  const entries: VerificationResult['entries'] = [];
  let passing = true;

  const manifestNames = new Set(manifest.navigatedRuleReferences.map((r) => r.ruleName));
  // The manifest also lists dotted-path and alternate-source rules, which
  // detectors resolve through shared helpers; treat those as covered too.
  for (const name of manifest.dottedPathRules) {
    manifestNames.add(name);
  }
  for (const name of manifest.alternateSourceRules) {
    manifestNames.add(name);
  }
  for (const name of manifest.commandRuleNames) {
    manifestNames.add(name);
  }

  const found = new Set<string>();
  for (const file of detectorSourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const name of extractNavigatedRuleNames(source)) {
      found.add(name);
    }
  }

  for (const name of found) {
    if (!manifestNames.has(name) && !SCAN_EXEMPT_RULE_NAMES.has(name)) {
      passing = false;
      entries.push({
        category: 'no-op',
        status: 'failure',
        message: `Detector source navigates rule "${name}" but it is absent from the manifest's navigatedRuleReferences; a stale grammar would make it silently no-op undetected.`,
        context: { rule: name },
      });
    }
  }

  if (passing) {
    entries.push({
      category: 'no-op',
      status: 'pass',
      message: `All ${found.size} source-navigated rule names are covered by the manifest.`,
      context: {},
    });
  }
  return { category: 'no-op', passing, entries: [...entries] };
}
