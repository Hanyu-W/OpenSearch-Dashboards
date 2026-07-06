/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandInventory } from './grammar_command_inventory';
import { GrammarSurface } from './grammar_surface';
import {
  ClassificationDecision,
  ClassificationManifest,
  SurfaceName,
  VerificationEntry,
  VerificationResult,
} from './types';

const MAX_REASON_LENGTH = 500;

/**
 * Which classification tables apply to a surface. Both current tables apply to
 * every surface (they classify the shared command vocabulary). Kept as a
 * function so a future surface-specific table can opt out.
 */
function relevantTables(
  manifest: ClassificationManifest,
  _surface: SurfaceName
): Array<[string, readonly ClassificationDecision[]]> {
  return Object.entries(manifest.tableExclusions);
}

/**
 * Force every command in the active inventory to have exactly one classification
 * decision in every relevant table, and report stale manifest entries (commands
 * that no longer exist in the inventory) as a distinct failure category
 * (R4.1-R4.7). Missing classifications, duplicate decisions, empty reasons, and
 * stale entries each fail with command, table, and surface context.
 */
export function assertClassificationCompleteness(
  surface: GrammarSurface,
  inventory: CommandInventory,
  manifest: ClassificationManifest
): VerificationResult {
  const entries: VerificationEntry[] = [];
  let passing = true;

  const fail = (message: string, rule: string) => {
    passing = false;
    entries.push({
      category: 'census',
      status: 'failure',
      message,
      context: { surface: surface.name, rule },
    });
  };

  for (const [tableName, decisions] of relevantTables(manifest, surface.name)) {
    // Only decisions in scope for this surface participate in the census here.
    const inScope = decisions.filter((d) => decisionAppliesToSurface(d, surface.name));

    // Group in-scope decisions by command for O(1) lookup and duplicate detection.
    const byCommand = new Map<string, ClassificationDecision[]>();
    for (const decision of inScope) {
      const list = byCommand.get(decision.commandRuleName) ?? [];
      list.push(decision);
      byCommand.set(decision.commandRuleName, list);
    }

    // Totality: every inventory command has exactly one in-scope decision.
    for (const command of inventory.commandRules) {
      const found = byCommand.get(command) ?? [];
      if (found.length === 0) {
        fail(
          `Command "${command}" has no classification in table "${tableName}" on ${surface.name}.`,
          command
        );
      } else if (found.length > 1) {
        fail(
          `Command "${command}" has ${found.length} classifications in table "${tableName}" on ${surface.name} (expected 1).`,
          command
        );
      } else {
        const decision = found[0];
        if (requiresReason(decision) && !hasValidReason(decision)) {
          fail(
            `Decision "${decision.decision}" for "${command}" in table "${tableName}" is missing a valid reason.`,
            command
          );
        }
      }
    }

    // Staleness: an in-scope manifest command absent from THIS surface's
    // inventory is stale (the decision claims the surface but the grammar lacks
    // the command). Out-of-scope decisions are ignored for this surface.
    for (const command of byCommand.keys()) {
      if (!inventory.commandRules.has(command)) {
        passing = false;
        entries.push({
          category: 'census',
          status: 'failure',
          message: `Stale manifest entry: "${command}" in table "${tableName}" is scoped to ${surface.name} but is not in that surface's inventory.`,
          context: { surface: surface.name, rule: command },
        });
      }
    }
  }

  if (passing) {
    entries.push({
      category: 'census',
      status: 'pass',
      message: `Every command is classified exactly once in every table on ${surface.name}.`,
      context: { surface: surface.name },
    });
  }

  return { category: 'census', passing, entries };
}

/** A decision applies to a surface when its scope is absent (all) or lists it. */
function decisionAppliesToSurface(decision: ClassificationDecision, surface: SurfaceName): boolean {
  return !decision.surfaceScope || decision.surfaceScope.includes(surface);
}

function requiresReason(decision: ClassificationDecision): boolean {
  return decision.decision === 'excluded' || decision.decision === 'not_applicable';
}

function hasValidReason(decision: ClassificationDecision): boolean {
  const reason = decision.reason?.trim() ?? '';
  return reason.length >= 1 && reason.length <= MAX_REASON_LENGTH;
}
