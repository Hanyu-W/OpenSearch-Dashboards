/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { RuleHelp } from '../types';
import { HoverFacts } from './hover_registry';

/**
 * Pure renderer for the lint hover card ("view more") body. Composes the static
 * per-rule guidance, additive per-instance context, an optional quick-fix
 * preview, and the doc link into a single Markdown string. Intentionally free of
 * any Monaco import so it is trivially unit-testable; the provider does the
 * Monaco-specific marker extraction and hands plain values here.
 *
 * The detector message already identifies the problem and its consequence.
 * Keeping the card focused on that message and the next action avoids repeating
 * the same field, value, and engine outcome in several differently named
 * sections.
 */

export type SeverityLabel = 'Error' | 'Warning' | 'Info';

export interface HoverCardInput {
  severityLabel: SeverityLabel;
  /** The marker's short message — always shown as the card lead. */
  message: string;
  /** code.target — the specific doc link from the catalog. */
  docUrl?: string;
  /** Static, task-oriented guidance for this rule. */
  content?: RuleHelp;
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
 * Render only context that adds information beyond the detector message. Most
 * detectors already include their field, type, and value in the message, so
 * repeating those facts would make the card longer without helping the user.
 */
function renderAdditionalContext(facts: HoverFacts): string | undefined {
  // Wildcard zero-match: the count and nearby names are not in the marker text.
  if (facts.pattern !== undefined) {
    const parts: string[] = [];
    if (facts.totalIndices !== undefined) {
      const noun = facts.totalIndices === 1 ? 'index' : 'indices';
      parts.push(`Checked ${facts.totalIndices} visible ${noun}.`);
    }
    if (facts.candidateIndices && facts.candidateIndices.length > 0) {
      parts.push(`Similar names: ${facts.candidateIndices.map(code).join(', ')}.`);
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  // Explain-backed messages identify the operation but may not name the field
  // that attribution resolved after the diagnostic was created.
  if (facts.operation !== undefined && facts.field !== undefined) {
    const parts: string[] = [];
    parts.push(`Affected field: ${code(facts.field)}.`);
    if (facts.literal !== undefined) {
      parts.push(`Comparison value: ${code(facts.literal)}.`);
    }
    return parts.join(' ');
  }

  return undefined;
}

/**
 * Render the full hover card to a Markdown string. The provider wraps the result
 * in `{ value, isTrusted: false }` and hands it to Monaco.
 */
export function renderHoverCard(input: HoverCardInput): string {
  const { severityLabel, message, docUrl, content, facts, fixText } = input;
  const lines: string[] = [];

  // The rule id remains on the marker for lookup and support diagnostics, but it
  // is implementation detail rather than the card's headline.
  lines.push(`${SEVERITY_GLYPH[severityLabel]} **${severityLabel}**`);

  // Lead: the short message (always present).
  lines.push('');
  lines.push(escapeInline(message));

  // Add only facts not already stated by the detector.
  if (facts) {
    const contextLine = renderAdditionalContext(facts);
    if (contextLine) {
      lines.push('');
      lines.push(`**Details** — ${contextLine}`);
    }
  }

  // Every known rule gives the user a concrete next action, whether or not an
  // automatic edit can be offered safely.
  if (content) {
    lines.push('');
    lines.push(`**Fix** — ${content.howToFix}`);
  }

  // Exact replacement preview for deterministic quick fixes.
  if (fixText !== undefined) {
    lines.push('');
    lines.push(`**Quick fix available** — ${code(fixText)}`);
  }

  // Note: the AI ("Ask AI to fix") action is intentionally NOT rendered on the
  // hover card. It is offered solely through the ⌘. quick-fix menu (see
  // code_action_provider) to avoid presenting the same action twice.

  // Learn more — the specific doc link.
  if (docUrl) {
    lines.push('');
    lines.push(`[Learn more →](${encodeLinkTarget(docUrl)})`);
  }

  return lines.join('\n');
}
