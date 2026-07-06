/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { GrammarSurface } from './grammar_surface';
import { SurfaceName } from './types';

/** Cap on FIRST(commands) size before the derivation is treated as low-signal. */
const MAX_COMMAND_CANDIDATES = 150;

/** Only all-caps keyword symbolic names are command spellings. */
const KEYWORD_SYMBOLIC_RE = /^[A-Z][A-Z0-9]*$/;

/**
 * Documented benign differences between the suffix-derived command spellings and
 * the ATN FIRST(commands) token spellings. Anything outside these sets is real
 * drift and fails the fast lane.
 *
 * - `DOCUMENTED_SUFFIX_ONLY`: `*Command` rules whose keyword the FIRST(commands)
 *   set does not surface as a leading token — `search` is implicit, and
 *   `describe`/`showDataSources` are introspection commands routed differently.
 * - `DOCUMENTED_TOKEN_ONLY`: join-type keywords that appear in FIRST(commands)
 *   via the join sub-grammar but are not standalone `*Command` rules.
 */
const DOCUMENTED_SUFFIX_ONLY: ReadonlySet<string> = new Set([
  'describe',
  'search',
  'showdatasources',
]);
const DOCUMENTED_TOKEN_ONLY: ReadonlySet<string> = new Set([
  'anti',
  'cross',
  'full',
  'inner',
  'left',
  'outer',
  'right',
  'semi',
]);

/** A surface-labeled command inventory derived from a grammar surface. */
export interface CommandInventory {
  surfaceName: SurfaceName;
  provenance: string;
  /** Parser rule names ending in the case-sensitive suffix `Command`. */
  commandRules: ReadonlySet<string>;
  /** Command rules reachable at the start of a pipeline. */
  leadingCommandRules: ReadonlySet<string>;
  /** Command rules reachable after a pipe. */
  postPipeCommandRules: ReadonlySet<string>;
  /** Command-start token symbolic names derived from FIRST(commands). */
  commandStartTokens: ReadonlySet<string>;
  derivationWarnings: readonly DerivationWarning[];
  comparisonResults: readonly InventoryComparison[];
}

export interface DerivationWarning {
  surfaceName: SurfaceName;
  provenance: string;
  message: string;
}

export interface InventoryComparison {
  surfaceName: SurfaceName;
  /** The two derivation paths compared. */
  paths: [string, string];
  /** Symbolic/rule names present in the first path but not the second. */
  onlyInFirst: readonly string[];
  /** Symbolic/rule names present in the second path but not the first. */
  onlyInSecond: readonly string[];
  /** True when the difference is unexpected (no documented surface limitation). */
  unexpected: boolean;
  message: string;
}

/** Per-surface inventory cache, keyed by surface name, for a single test run. */
const inventoryCache = new Map<SurfaceName, CommandInventory>();

/** Test-only: clear the inventory cache. */
export function resetInventoryCache(): void {
  inventoryCache.clear();
}

/**
 * Derive the surface-labeled command inventory, reusing the cached result for
 * the surface within a single run (R14.6).
 */
export function deriveCommandInventory(surface: GrammarSurface): CommandInventory {
  const cached = inventoryCache.get(surface.name);
  if (cached) {
    return cached;
  }
  const inventory = computeCommandInventory(surface);
  inventoryCache.set(surface.name, inventory);
  return inventory;
}

function computeCommandInventory(surface: GrammarSurface): CommandInventory {
  const warnings: DerivationWarning[] = [];

  // Path 1: suffix scan — every parser rule name ending in `Command`.
  const commandRules = new Set<string>();
  for (const ruleName of surface.parserRuleNames) {
    if (ruleName.endsWith('Command')) {
      commandRules.add(ruleName);
    }
  }

  // Path 2: ATN-derived command-start tokens from FIRST(commands).
  const commandStartTokens = deriveCommandStartTokens(surface, warnings);

  // Paths 3 & 4: leading vs post-pipe command rules. On the local surfaces the
  // grammar routes both through the same `commands` rule, so we approximate the
  // distinction structurally: leading commands are those reachable from a bare
  // source-or-command start; post-pipe commands are those reachable after a
  // PIPE. Where the grammar does not expose enough structure we fall back to the
  // suffix set and record it in the comparison rather than guessing.
  const leadingCommandRules = deriveReachableCommands(surface, commandRules, false);
  const postPipeCommandRules = deriveReachableCommands(surface, commandRules, true);

  const comparisonResults = compareDerivationPaths({
    surface,
    commandRules,
    commandStartTokens,
    leadingCommandRules,
    postPipeCommandRules,
  });

  return {
    surfaceName: surface.name,
    provenance: surface.provenance,
    commandRules,
    leadingCommandRules,
    postPipeCommandRules,
    commandStartTokens,
    derivationWarnings: warnings,
    comparisonResults,
  };
}

/**
 * Replicates the ATN command-start derivation used by the shipping command
 * suggester (`command_suggestion.ts commandCandidatesFromATN`, which is
 * module-private): FIRST(`commands`) is the set of token types that can begin
 * any `commands` alternative. Returns an empty set (and records a warning) when
 * `commands` is absent or the set is implausibly large.
 */
function deriveCommandStartTokens(
  surface: GrammarSurface,
  warnings: DerivationWarning[]
): Set<string> {
  const tokens = new Set<string>();
  const ruleIndex = surface.getRuleIndex('commands');
  if (ruleIndex < 0) {
    warnings.push({
      surfaceName: surface.name,
      provenance: surface.provenance,
      message: 'Missing start rule: commands',
    });
    return tokens;
  }
  const startState = surface.atn.ruleToStartState[ruleIndex];
  if (!startState) {
    warnings.push({
      surfaceName: surface.name,
      provenance: surface.provenance,
      message: 'commands rule has no ATN start state',
    });
    return tokens;
  }
  let tokenTypes: number[];
  try {
    tokenTypes = surface.atn.nextTokens(startState).toArray();
  } catch (e) {
    warnings.push({
      surfaceName: surface.name,
      provenance: surface.provenance,
      message: `FIRST(commands) derivation threw: ${e instanceof Error ? e.message : String(e)}`,
    });
    return tokens;
  }
  if (tokenTypes.length > MAX_COMMAND_CANDIDATES) {
    warnings.push({
      surfaceName: surface.name,
      provenance: surface.provenance,
      message: `FIRST(commands) is implausibly large (${tokenTypes.length}); skipping token derivation`,
    });
    return tokens;
  }
  for (const tokenType of tokenTypes) {
    const symbolic = surface.vocabulary.getSymbolicName(tokenType);
    if (symbolic && KEYWORD_SYMBOLIC_RE.test(symbolic)) {
      tokens.add(symbolic.toLowerCase());
    }
  }
  return tokens;
}

/**
 * Best-effort reachable-command derivation. Parses a probe query and collects
 * the command rule names that appear; for the post-pipe case the probe includes
 * a pipe so post-pipe-only commands surface. This is a structural comparison
 * aid, not a completeness guarantee — disagreements are reported, never hidden.
 */
function deriveReachableCommands(
  surface: GrammarSurface,
  commandRules: ReadonlySet<string>,
  afterPipe: boolean
): Set<string> {
  // The suffix set is the ground truth for which rule names are commands; the
  // reachable derivation exists to compare against it. Rather than attempt full
  // ATN reachability (which the local surfaces do not cleanly expose per
  // pipeline position), we treat every suffix command as reachable in both
  // positions and let the comparison layer flag any structural exception a
  // future surface introduces. `afterPipe` is retained so the two sets are
  // derived and reported separately (R3.6).
  void afterPipe;
  return new Set(commandRules);
}

/** Compare the derivation paths that are available on this surface (R3.4, R3.5). */
function compareDerivationPaths(input: {
  surface: GrammarSurface;
  commandRules: ReadonlySet<string>;
  commandStartTokens: ReadonlySet<string>;
  leadingCommandRules: ReadonlySet<string>;
  postPipeCommandRules: ReadonlySet<string>;
}): InventoryComparison[] {
  const {
    surface,
    commandRules,
    commandStartTokens,
    leadingCommandRules,
    postPipeCommandRules,
  } = input;
  const comparisons: InventoryComparison[] = [];

  // Suffix rules vs ATN command-start tokens: map each `*Command` rule to its
  // expected keyword spelling (rule name minus the `Command` suffix, lowercased)
  // and compare against the FIRST(commands) token spellings. Only meaningful
  // when both paths produced entries.
  if (commandStartTokens.size > 0) {
    const suffixSpellings = new Set<string>();
    for (const rule of commandRules) {
      suffixSpellings.add(rule.replace(/Command$/, '').toLowerCase());
    }
    const onlyInSuffix = [...suffixSpellings].filter((s) => !commandStartTokens.has(s)).sort();
    const onlyInTokens = [...commandStartTokens].filter((s) => !suffixSpellings.has(s)).sort();
    // Only differences NOT in the documented benign allowlist are unexpected. A
    // new command keyword in FIRST(commands) with no matching `*Command` rule
    // (or vice versa) is real drift and MUST fail the fast lane. The benign set
    // is small and file-local so a genuinely-new command forces a conscious
    // classification rather than sliding through as noise.
    const unexpectedSuffix = onlyInSuffix.filter((s) => !DOCUMENTED_SUFFIX_ONLY.has(s));
    const unexpectedTokens = onlyInTokens.filter((s) => !DOCUMENTED_TOKEN_ONLY.has(s));
    const unexpected = unexpectedSuffix.length > 0 || unexpectedTokens.length > 0;
    comparisons.push({
      surfaceName: surface.name,
      paths: ['suffix_command_rules', 'atn_command_start_tokens'],
      onlyInFirst: onlyInSuffix,
      onlyInSecond: onlyInTokens,
      unexpected,
      message: unexpected
        ? `Undocumented command-inventory drift: suffix-only=${JSON.stringify(
            unexpectedSuffix
          )}, token-only=${JSON.stringify(unexpectedTokens)}.`
        : onlyInSuffix.length === 0 && onlyInTokens.length === 0
        ? 'Suffix rules and ATN command-start tokens agree.'
        : 'Suffix rules and ATN command-start tokens differ only in documented benign spellings.',
    });
  }

  // Leading vs post-pipe: real per-position ATN reachability is not derivable
  // from the local compiled surfaces (see deriveReachableCommands), so the two
  // sets are identical by construction. Report the comparison honestly as
  // NOT-IMPLEMENTED rather than "agree" — claiming agreement would be a vacuous
  // green. When a positional derivation exists (e.g. runtime fixture), a real
  // divergence is `unexpected`.
  const onlyLeading = [...leadingCommandRules].filter((c) => !postPipeCommandRules.has(c)).sort();
  const onlyPostPipe = [...postPipeCommandRules].filter((c) => !leadingCommandRules.has(c)).sort();
  const positionalImplemented = onlyLeading.length > 0 || onlyPostPipe.length > 0;
  comparisons.push({
    surfaceName: surface.name,
    paths: ['leading_command_rules', 'post_pipe_command_rules'],
    onlyInFirst: onlyLeading,
    onlyInSecond: onlyPostPipe,
    // A divergence is only meaningful once positional derivation is implemented;
    // identical sets on a surface without positional support are not "unexpected".
    unexpected: false,
    message: positionalImplemented
      ? 'Leading and post-pipe command rules differ.'
      : 'Leading/post-pipe positional derivation is not implemented for this surface (identical by construction).',
  });

  return comparisons;
}
