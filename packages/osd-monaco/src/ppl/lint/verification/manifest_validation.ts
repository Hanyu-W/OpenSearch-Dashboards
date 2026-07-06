/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClassificationDecision, ClassificationManifest, VerificationResult } from './types';

const MAX_REASON_LENGTH = 500;

/**
 * Validate structural invariants of the {@link ClassificationManifest} that the
 * census does not otherwise check: exclusion/not-applicable reason length, the
 * zero-divisor operator set staying `['/']` until evidence expands it, and the
 * order-effect table being marked as added semantics. Returns structured
 * entries rather than throwing (R2.4, R2.5, R2.6, R2.7).
 */
export function validateManifest(manifest: ClassificationManifest): VerificationResult {
  const entries: VerificationResult['entries'] = [];
  let passing = true;

  const fail = (message: string, rule?: string) => {
    passing = false;
    entries.push({ category: 'manifest', status: 'failure', message, context: { rule } });
  };

  // Every excluded / not-applicable decision needs a 1..500 char reason.
  const checkReason = (decision: ClassificationDecision, tableName: string) => {
    if (decision.decision === 'included') {
      return;
    }
    const reason = decision.reason?.trim() ?? '';
    if (reason.length < 1 || reason.length > MAX_REASON_LENGTH) {
      fail(
        `Decision "${decision.decision}" for "${decision.commandRuleName}" in table "${tableName}" ` +
          `needs a 1..${MAX_REASON_LENGTH} char reason (got ${reason.length}).`,
        decision.commandRuleName
      );
    }
  };

  for (const [tableName, decisions] of Object.entries(manifest.tableExclusions)) {
    for (const decision of decisions) {
      checkReason(decision, tableName);
    }
  }

  // Zero-divisor operator set: exactly `/` until reviewed evidence expands it.
  const operators = manifest.zeroDivisorOperators;
  if (operators.length !== 1 || operators[0] !== '/') {
    fail(
      `zeroDivisorOperators must remain exactly ['/'] without reviewed engine evidence ` +
        `(got ${JSON.stringify(operators)}).`
    );
  }

  // Order-effect table entries must carry an orderEffect (added semantics) and a
  // reason. This makes the "added detector semantics" nature explicit and
  // reviewable rather than a silent hoist (R2.4).
  for (const [command, decision] of Object.entries(manifest.orderEffectByCommand)) {
    if (!decision.orderEffect) {
      fail(`Order-effect entry for "${command}" is missing an orderEffect decision.`, command);
    }
    const reason = decision.reason?.trim() ?? '';
    if (reason.length < 1 || reason.length > MAX_REASON_LENGTH) {
      fail(
        `Order-effect entry for "${command}" needs a 1..${MAX_REASON_LENGTH} char reason.`,
        command
      );
    }
  }

  if (passing) {
    entries.push({
      category: 'manifest',
      status: 'pass',
      message: 'Manifest structural invariants hold.',
      context: {},
    });
  }

  return { category: 'manifest', passing, entries: [...entries] };
}

/**
 * Assert that the value a detector imports and the value the census reads for a
 * hoisted category are identical (R2.8). Because both sides import the same
 * module-level constant, this is a referential-identity check: it fails only if
 * a future refactor forks the constant.
 */
export function assertManifestImportIdentity(
  detectorValue: unknown,
  censusValue: unknown,
  category: string
): VerificationResult {
  const same = detectorValue === censusValue || deepEqual(detectorValue, censusValue);
  return {
    category: 'manifest',
    passing: same,
    entries: [
      same
        ? {
            category: 'manifest',
            status: 'pass',
            message: `Detector and census read identical "${category}".`,
            context: {},
          }
        : {
            category: 'manifest',
            status: 'failure',
            message: `Detector and census read different "${category}" values.`,
            context: { rule: category },
          },
    ],
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}
