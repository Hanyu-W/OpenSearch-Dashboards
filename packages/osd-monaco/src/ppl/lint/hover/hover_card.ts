/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { RuleHoverContent, FailureClass } from './engine_outcomes';
import { HoverFacts } from './hover_registry';

/**
 * Pure renderer for the lint hover card ("view more") body. Composes the static
 * per-rule content, per-instance facts, an optional fix preview, and the doc
 * link into a single Markdown string. Intentionally free of any Monaco import so
 * it is trivially unit-testable; the provider does the Monaco-specific marker
 * extraction and hands plain values here.
 *
 * Every section renders only when its data is present, so a bare rule (no static
 * entry, no facts) degrades to just the message — never throws, never blank.
 */

export type SeverityLabel = 'Error' | 'Warning' | 'Info';

export interface HoverCardInput {
  ruleId: string;
  severityLabel: SeverityLabel;
  /** The marker's short message — always shown as the card lead. */
  message: string;
  /** code.target — the specific doc link from the catalog (Part A). */
  docUrl?: string;
  /** Static per-rule content from engine_outcomes, when present. */
  content?: RuleHoverContent;
  /** Per-instance facts from the detector, when present. */
  facts?: HoverFacts;
  /** Quick-fix preview text (the replacement), when a DiagnosticFix exists. */
  fixText?: string;
}

const SEVERITY_GLYPH: Record<SeverityLabel, string> = {
  Error: '❌', // ❌
  Warning: '⚠️', // ⚠️
  Info: 'ℹ️', // ℹ️
};

// How each runtime outcome class reads in the "Why <severity>" line. Decodes the
// severity into the consequence the user actually faces — the silent classes are
// the ones users most often under-rate.
const FAILURE_CLASS_EXPLAINER: Record<FailureClass, string> = {
  'silent-null':
    'the query succeeds (HTTP 200) but a value resolves to null and propagates silently — nothing signals that anything went wrong.',
  'silent-empty':
    'the query succeeds (HTTP 200) but matches zero rows — it looks like "no data" rather than a mistake.',
  'engine-throw': 'the engine rejects the query, so it will not run.',
  nondeterministic:
    'the query runs, but the rows it returns are not stable across identical re-runs.',
  fallback:
    'the primary engine cannot run this natively and falls back to a secondary engine — it succeeds, but on a slower path.',
  advisory:
    'the query runs and may return data, but the command can behave differently than intended on this input — this is a heads-up, not a guaranteed outcome.',
};

/**
 * Escape the Markdown-significant characters we may inline verbatim. Covers the
 * inline-context specials: code/emphasis (`` ` `` `*` `_`), links (`[` `]`),
 * autolink/HTML (`<` `>`), strikethrough (`~`), and table cells (`|`). `(`/`)`
 * `#` `-` are only significant at line-start, and every inline string here is
 * prefixed (e.g. `**Label** — `), so they are left alone to keep prose readable.
 */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]<>~|])/g, '\\$1');
}

/**
 * Render a value as inline code. When the value itself contains backticks, fence
 * it with a longer run of backticks (and pad with a space, per CommonMark §6.3)
 * so the literal backticks survive verbatim rather than being substituted for a
 * lookalike glyph.
 */
function code(text: string): string {
  const runs = text.match(/`+/g);
  let longestRun = 0;
  if (runs) {
    for (const run of runs) {
      longestRun = Math.max(longestRun, run.length);
    }
  }
  const fence = '`'.repeat(longestRun + 1);
  const pad = longestRun > 0 ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Make a URL safe to drop into a Markdown link target. An unescaped `)` would
 * close the `[text](url)` form early; percent-encoding parens keeps the link
 * intact and is decoded transparently by the browser.
 */
function encodeLinkTarget(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Build the "Your query" line from per-instance facts. Returns undefined when
 * there is nothing instance-specific worth showing.
 */
function renderFactsLine(facts: HoverFacts): string | undefined {
  // Wildcard zero-match: enumerate near candidates so the user is unstuck.
  if (facts.pattern !== undefined) {
    const head =
      facts.totalIndices !== undefined
        ? `${code(facts.pattern)} matched 0 of ${facts.totalIndices} visible indices.`
        : `${code(facts.pattern)} matched no visible index.`;
    if (facts.candidateIndices && facts.candidateIndices.length > 0) {
      return `${head} Did you mean one of: ${facts.candidateIndices.map(code).join(', ')}?`;
    }
    return head;
  }

  // Field/type-centric rules.
  if (facts.field !== undefined) {
    const parts: string[] = [];
    if (facts.root !== undefined) {
      // The field is a subfield of `root`; here `esType` describes the *root*
      // object's mapping, not the subfield (the subfield has no mapping of its
      // own). Attribute the type to the root so the card never claims the
      // subfield "is mapped as <type>".
      parts.push(
        facts.esType !== undefined
          ? `${code(facts.field)} lives inside ${code(facts.root)}, mapped as ${code(
              facts.esType
            )} on this index.`
          : `${code(facts.field)} lives inside ${code(facts.root)}.`
      );
    } else if (facts.esType !== undefined) {
      parts.push(`${code(facts.field)} is mapped as ${code(facts.esType)} on this index.`);
    } else {
      parts.push(`${code(facts.field)}.`);
    }
    if (facts.aggName !== undefined) {
      parts.push(`${code(facts.aggName + '()')} needs a numeric type.`);
    }
    if (facts.literal !== undefined) {
      parts.push(`Compared to ${code(facts.literal)}.`);
    }
    if (facts.suggestion !== undefined) {
      parts.push(`Closest known field: ${code(facts.suggestion)}.`);
    }
    return parts.join(' ');
  }

  // Bare literal (e.g. the actual zero divisor).
  if (facts.literal !== undefined) {
    return `Offending value: ${code(facts.literal)}.`;
  }

  return undefined;
}

/**
 * Render the full hover card to a Markdown string. The provider wraps the result
 * in `{ value, isTrusted: false }` and hands it to Monaco.
 */
export function renderHoverCard(input: HoverCardInput): string {
  const { ruleId, severityLabel, message, docUrl, content, facts, fixText } = input;
  const lines: string[] = [];

  // Header: glyph · ruleId · severity.
  lines.push(`${SEVERITY_GLYPH[severityLabel]} **${escapeInline(ruleId)}** · ${severityLabel}`);

  // Lead: the short message (always present).
  lines.push('');
  lines.push(escapeInline(message));

  // Engine behavior — the highest-value line.
  if (content) {
    const verified = content.verifiedVersion
      ? ` _(verified on OpenSearch ${escapeInline(content.verifiedVersion)})_`
      : '';
    lines.push('');
    lines.push(`**Engine behavior** — ${escapeInline(content.engineBehavior)}${verified}`);
  }

  // Your query — per-instance facts.
  if (facts) {
    const factsLine = renderFactsLine(facts);
    if (factsLine) {
      lines.push('');
      lines.push(`**Your query** — ${factsLine}`);
    }
  }

  // Why <severity> — decode the runtime outcome class.
  if (content) {
    lines.push('');
    lines.push(
      `**Why ${severityLabel.toLowerCase()}** — ${FAILURE_CLASS_EXPLAINER[content.failureClass]}`
    );
  }

  // Suggested fix preview.
  if (fixText !== undefined) {
    lines.push('');
    lines.push(`**Suggested fix** → ${code(fixText)}`);
  }

  // Escape hatch — only when present (never for error severity, by data rule).
  // For engine-throw rules the query genuinely would not run, so the only reason
  // to dismiss the warning is that the linter is being conservative: label it a
  // "Possible false positive". For the runs-anyway classes it really is "Safe to
  // ignore". This keeps the line from contradicting the "Why <severity>" line.
  if (content?.safeToIgnoreWhen) {
    const label =
      content.failureClass === 'engine-throw' ? 'Possible false positive' : 'Safe to ignore';
    lines.push('');
    lines.push(`**${label}** — ${escapeInline(content.safeToIgnoreWhen)}`);
  }

  // Learn more — the specific doc link.
  if (docUrl) {
    lines.push('');
    lines.push(`[Learn more →](${encodeLinkTarget(docUrl)})`);
  }

  return lines.join('\n');
}
