/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { OrderEffectDecision, VerificationResult } from './types';

/**
 * How the diagnostic verdict is expected to relate between a seed query and a
 * single-mutation mutant. `identical` = seed and mutant fire the same;
 * `mutant_fires_when_seed_quiet` = inserting the command introduces a finding a
 * quiet seed lacked.
 */
export type DiagnosticRelation = 'identical' | 'mutant_fires_when_seed_quiet';

/** A pointer to the independently reviewed evidence for a command fact. */
export interface EvidenceReference {
  /** e.g. 'live-cluster', 'engine-docs', 'sql-issue'. */
  kind: string;
  /** A human-checkable locator: URL, issue id, or capture id. */
  locator: string;
  /** Optional engine version the evidence was captured against. */
  engineVersion?: string;
}

/** Independently reviewed facts about one command. */
export interface CommandEngineFacts {
  orderEffect?: OrderEffectDecision;
  /** For reverse: how a reverse insertion between sort and head should behave. */
  reverseOrderExpectation?: DiagnosticRelation;
  evidence: readonly EvidenceReference[];
}

/**
 * A checked-in artifact of independently reviewed engine facts, used ONLY as a
 * verification oracle. It is never read to generate shipped detector behavior
 * (R11.2, R11.3).
 */
export interface EngineFactsBaseline {
  baselineId: string;
  engineVersion: string;
  grammarProvenance: string;
  grammarHash: string;
  commands: Readonly<Record<string, CommandEngineFacts>>;
}

/**
 * The checked-in baseline. Order effects are seeded from reviewed engine
 * behavior (OpenSearch PPL command semantics); each carries at least one
 * evidence reference. This is intentionally an oracle, deliberately separate
 * from the detector-facing order-effect table in the classification manifest so
 * the metamorphic relations test the detector table against an *independent*
 * source (R10.1).
 */
const BASELINE_COMMANDS: Record<string, CommandEngineFacts> = {
  sortCommand: {
    orderEffect: 'establishes_order',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/sort', engineVersion: '3.7.0' }],
  },
  reverseCommand: {
    orderEffect: 'reverses_order',
    reverseOrderExpectation: 'identical',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/reverse', engineVersion: '3.7.0' }],
  },
  headCommand: {
    orderEffect: 'preserves_order',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/head', engineVersion: '3.7.0' }],
  },
  fieldsCommand: {
    orderEffect: 'preserves_order',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/fields', engineVersion: '3.7.0' }],
  },
  whereCommand: {
    orderEffect: 'preserves_order',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/where', engineVersion: '3.7.0' }],
  },
  evalCommand: {
    orderEffect: 'preserves_order',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/eval', engineVersion: '3.7.0' }],
  },
  renameCommand: {
    orderEffect: 'preserves_order',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/rename', engineVersion: '3.7.0' }],
  },
  statsCommand: {
    orderEffect: 'destroys_order',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/stats', engineVersion: '3.7.0' }],
  },
  dedupCommand: {
    orderEffect: 'preserves_order',
    evidence: [{ kind: 'engine-docs', locator: 'ppl/commands/dedup', engineVersion: '3.7.0' }],
  },
};

export const ENGINE_FACTS_BASELINE: EngineFactsBaseline = Object.freeze({
  baselineId: 'ppl-order-effects-2026-07',
  engineVersion: '3.7.0',
  grammarProvenance: 'reviewed engine behavior (OpenSearch PPL command reference)',
  grammarHash: 'reviewed:ppl-3.7-order-effects',
  commands: Object.freeze(BASELINE_COMMANDS),
});

/**
 * Validate the baseline's structural invariants: non-empty id/version/
 * provenance/hash, at least one command fact, and at least one evidence
 * reference per command fact (R11.1).
 */
export function validateEngineFactsBaseline(baseline: EngineFactsBaseline): VerificationResult {
  const entries: VerificationResult['entries'] = [];
  let passing = true;
  const fail = (message: string, rule?: string) => {
    passing = false;
    entries.push({ category: 'metamorphic', status: 'failure', message, context: { rule } });
  };

  for (const [field, value] of Object.entries({
    baselineId: baseline.baselineId,
    engineVersion: baseline.engineVersion,
    grammarProvenance: baseline.grammarProvenance,
    grammarHash: baseline.grammarHash,
  })) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail(`EngineFactsBaseline.${field} must be a non-empty string.`);
    }
  }

  const commandEntries = Object.entries(baseline.commands);
  if (commandEntries.length === 0) {
    fail('EngineFactsBaseline must record at least one command fact.');
  }
  for (const [command, facts] of commandEntries) {
    if (!facts.evidence || facts.evidence.length === 0) {
      fail(`Command fact "${command}" has no evidence reference.`, command);
    }
  }

  if (passing) {
    entries.push({
      category: 'metamorphic',
      status: 'pass',
      message: 'EngineFactsBaseline structural invariants hold.',
      context: {},
    });
  }
  return { category: 'metamorphic', passing, entries: [...entries] };
}
