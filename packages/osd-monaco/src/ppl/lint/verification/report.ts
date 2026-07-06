/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CheckCategory,
  CheckStatus,
  EntryStatus,
  FAST_LANE_REQUIRED_CATEGORIES,
  Lane,
  VerificationContext,
  VerificationEntry,
  VerificationReport,
  VerificationResult,
  hasContext,
} from './types';

/**
 * Collects verification entries across checks and finalizes a
 * {@link VerificationReport}. A failure fails the pull-request lane only when it
 * carries at least one context field (surface, detector, rule, or query);
 * otherwise it is downgraded to `context-incomplete` so a poorly-contextualized
 * failure cannot silently block CI (R1.4, R1.5).
 */
export class VerificationReportBuilder {
  private readonly entries: VerificationEntry[] = [];
  private readonly seededCategories = new Set<CheckCategory>();

  constructor(private readonly lane: Lane) {}

  /** Merge a grouped check result into the report. */
  add(result: VerificationResult): this {
    this.seededCategories.add(result.category);
    for (const entry of result.entries) {
      this.entries.push(this.normalize(entry));
    }
    return this;
  }

  /** Append a single pass entry for a category (keeps the category present). */
  addPass(category: CheckCategory, message: string, context: VerificationContext = {}): this {
    return this.addEntry({ category, status: 'pass', message, context });
  }

  /** Append a single failure entry. Blocking/context-incomplete is decided later. */
  addFailure(category: CheckCategory, message: string, context: VerificationContext = {}): this {
    return this.addEntry({ category, status: 'failure', message, context });
  }

  /** Append a pending entry (e.g. runtime-fixture coverage while the fixture is absent). */
  addPending(category: CheckCategory, message: string, context: VerificationContext = {}): this {
    return this.addEntry({ category, status: 'pending', message, context });
  }

  /** Append a non-blocking warning. */
  addWarning(category: CheckCategory, message: string, context: VerificationContext = {}): this {
    return this.addEntry({ category, status: 'warning', message, context });
  }

  /** Append a single entry, normalizing failure blocking status. */
  addEntry(entry: VerificationEntry): this {
    this.seededCategories.add(entry.category);
    this.entries.push(this.normalize(entry));
    return this;
  }

  /**
   * Downgrade context-free failures to `context-incomplete`; leave everything
   * else untouched. Applied on ingress so the finalizer sees stable statuses.
   */
  private normalize(entry: VerificationEntry): VerificationEntry {
    if (entry.status === 'failure' && !hasContext(entry.context)) {
      return { ...entry, status: 'context-incomplete' };
    }
    return entry;
  }

  /**
   * Produce the finalized report. Guarantees a status for every fast-lane
   * required category (seeded to `not-run` if no check contributed one).
   */
  finalize(): VerificationReport {
    const statuses: Record<CheckCategory, CheckStatus> = {} as Record<CheckCategory, CheckStatus>;

    // Seed required categories so the report is always complete for the fast lane.
    const seed =
      this.lane === 'fast'
        ? new Set<CheckCategory>(FAST_LANE_REQUIRED_CATEGORIES)
        : new Set<CheckCategory>();
    for (const category of seed) {
      statuses[category] = 'not-run';
    }
    for (const category of this.seededCategories) {
      if (!(category in statuses)) {
        statuses[category] = 'not-run';
      }
    }

    for (const entry of this.entries) {
      statuses[entry.category] = rollUp(statuses[entry.category] ?? 'not-run', entry.status);
    }

    const blockingFailures = this.entries.filter((e) => e.status === 'failure');
    const warnings = this.entries.filter((e) => e.status === 'warning');
    const pending = this.entries.filter((e) => e.status === 'pending');

    return {
      lane: this.lane,
      statuses,
      entries: [...this.entries],
      blockingFailures,
      warnings,
      pending,
    };
  }
}

/**
 * Combine an existing category status with a new entry status. Failure is
 * strongest, then warning, then pending, then skipped, then pass. A prior
 * failure is never overwritten by a later pass.
 */
function rollUp(current: CheckStatus, entry: EntryStatus): CheckStatus {
  const mapped = mapEntryStatus(entry);
  return strongerStatus(current, mapped);
}

function mapEntryStatus(entry: EntryStatus): CheckStatus {
  switch (entry) {
    case 'failure':
    case 'blocking':
      return 'fail';
    case 'warning':
    case 'context-incomplete':
      return 'warning';
    case 'pending':
      return 'pending';
    case 'skipped':
      return 'skipped';
    case 'pass':
    default:
      return 'pass';
  }
}

const STATUS_RANK: Record<CheckStatus, number> = {
  fail: 5,
  warning: 4,
  pending: 3,
  skipped: 2,
  pass: 1,
  'not-run': 0,
};

function strongerStatus(a: CheckStatus, b: CheckStatus): CheckStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** A report has no blocking failures. Used by lane runners to decide CI outcome. */
export function reportPasses(report: VerificationReport): boolean {
  return report.blockingFailures.length === 0;
}

/** Human-readable failure summary for throwing out of a Jest lane. */
export function formatVerificationFailures(report: VerificationReport): string {
  if (report.blockingFailures.length === 0) {
    return `[${report.lane}] verification passed`;
  }
  const lines = report.blockingFailures.map((e) => {
    const ctx = [
      e.context.surface && `surface=${e.context.surface}`,
      e.context.detector && `detector=${e.context.detector}`,
      e.context.rule && `rule=${e.context.rule}`,
      e.context.query && `query=${JSON.stringify(e.context.query)}`,
    ]
      .filter(Boolean)
      .join(' ');
    return `  - [${e.category}] ${e.message}${ctx ? ` (${ctx})` : ''}`;
  });
  return `[${report.lane}] ${report.blockingFailures.length} blocking failure(s):\n${lines.join(
    '\n'
  )}`;
}

/** Build a passing single-entry result for a category. */
export function passResult(
  category: CheckCategory,
  context: VerificationContext = {}
): VerificationResult {
  return {
    category,
    passing: true,
    entries: [{ category, status: 'pass', message: 'ok', context }],
  };
}
