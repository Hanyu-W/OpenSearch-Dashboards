/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../monaco';
import { ID, PPL_TOKEN_SETS } from './constants';
import { getPPLLanguageAnalyzer, PPLValidationResult } from './ppl_language_analyzer';
import { getPPLDocumentationLink } from './ppl_documentation';
import { pplRangeFormatProvider } from './formatter';
import { resolvePPLValidationResult } from './validation_provider';
import { getPPLLintContext, isPPLLintEnabled, resolvePPLLintResult } from './lint_bridge';
import { LintResult } from './lint/diagnostic';
import { diagnosticToMarker, SYNTAX_MARKER_SOURCE } from './lint/diagnostic_to_marker';
import { pplLintCodeActionProvider } from './lint/code_action_provider';
import { registerAiFixCommand } from './lint/ai_fix/ai_fix_command';
import {
  clearModelFixes,
  clearModelSyntaxFixes,
  markerFixKey,
  MarkerFix,
  setModelFixes,
  setModelSyntaxFixes,
} from './lint/fix_registry';
import { LINT_OWNER, pplLintHoverProvider } from './lint/hover/hover_provider';
import { clearModelHoverFacts, HoverFacts, setModelHoverFacts } from './lint/hover/hover_registry';
import {
  analyzeCompiledPPLLint,
  lintCompiledPPL,
  stopCompiledPPLWorker,
  validateCompiledPPL,
  validateCompiledPPLLintQueries,
} from './compiled_worker_api';
import {
  emitPPLLintTelemetry,
  PPL_LINT_QUICKFIX_COMMAND_ID,
  PPL_LINT_TELEMETRY_EVENTS,
  resetPPLLintTelemetryDedup,
  ruleLabel,
} from './lint/telemetry';

const PPL_LANGUAGE_ID = ID;
const OWNER = 'PPL_WORKER';
// LINT_OWNER is defined in hover_provider.ts (its single source) and imported
// here, so the marker owner the lint lifecycle writes under and the owner the
// hover provider queries can never drift apart.
const LINT_DEBOUNCE_MS = 500;
const lintDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Monotonic per-model lint counter. Each lint pass claims a generation before
// dispatching its async worker call and only applies its markers if it is still
// the latest pass. This makes lint results "last-request-wins" rather than
// "last-response-wins", so an earlier pass whose response arrives late (e.g. the
// context-less lint fired on model creation, before the editor attaches the
// per-model context) can never overwrite a newer pass's markers.
const lintGenerations = new Map<string, number>();

// Same monotonic guard for the syntax-highlighting path: an earlier
// validation that resolves after a newer one must not clobber the newer
// markers (or resurrect a stale command-typo fix range).
const syntaxGenerations = new Map<string, number>();

// PPL analyzer for synchronous tokenization (lazy initialization)
let pplAnalyzer: ReturnType<typeof getPPLLanguageAnalyzer> | undefined;

/**
 * Map PPL Language Analyzer tokens to Monaco editor token classes
 * Based on ANTLR-generated token types from OpenSearchPPLLexer
 */
const mapPPLTokenToMonacoTokenType = (tokenType: string): string => {
  const type = tokenType.toUpperCase();

  // Use optimized Set lookups from constants
  for (const [monacoType, tokenSet] of Object.entries(PPL_TOKEN_SETS)) {
    if (tokenSet.has(type)) {
      return monacoType;
    }
  }

  // Default case
  return 'identifier';
};

/**
 * Create Monaco language configuration for PPL
 */
const createPPLLanguageConfiguration = (): monaco.languages.LanguageConfiguration => ({
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
});

/**
 * Set up synchronous tokenization for PPL
 */
const setupPPLTokenization = () => {
  monaco.languages.setTokensProvider(PPL_LANGUAGE_ID, {
    getInitialState: () => {
      const state = {
        clone: () => state,
        equals: () => true,
      };
      return state;
    },
    tokenize: (line: string, state: any) => {
      // Use PPL Language Analyzer for accurate tokenization
      const tokens: monaco.languages.IToken[] = [];

      try {
        // Only process if line contains potential PPL content
        if (line.trim()) {
          // Lazy initialize the PPL analyzer only when needed
          if (!pplAnalyzer) {
            pplAnalyzer = getPPLLanguageAnalyzer();
          }

          const pplTokens = pplAnalyzer.tokenize(line);

          for (const pplToken of pplTokens) {
            const tokenType = mapPPLTokenToMonacoTokenType(pplToken.type);
            tokens.push({
              startIndex: pplToken.startIndex,
              scopes: tokenType,
            });
          }
        }
      } catch (error) {
        // If ANTLR fails, return empty tokens
      }

      return {
        tokens,
        endState: state,
      };
    },
  });
};

/**
 * Process syntax highlighting for PPL models
 */
const processSyntaxHighlighting = async (model: monaco.editor.IModel) => {
  // Only process if the model is still set to PPL language
  if (model.getLanguageId() !== PPL_LANGUAGE_ID) {
    // Clear any existing PPL markers if language changed
    monaco.editor.setModelMarkers(model, OWNER, []);
    clearModelSyntaxFixes(model);
    return;
  }

  // Stamp this run so a slower, earlier validation that resolves after a newer
  // one cannot clobber the newer markers. Mirrors the lint path's guard.
  const generation = (syntaxGenerations.get(model.id) ?? 0) + 1;
  syntaxGenerations.set(model.id, generation);

  try {
    const content = model.getValue();

    const validationResult = (await resolvePPLValidationResult(
      model,
      content,
      validateCompiledPPL
    )) as PPLValidationResult;

    // Bail if a newer run started, the model was disposed, its content changed,
    // or it is no longer PPL while we were awaiting — writing now would resurrect
    // stale markers (and a stale command-typo fix range) over fresher state.
    if (
      syntaxGenerations.get(model.id) !== generation ||
      model.isDisposed() ||
      model.getValue() !== content ||
      model.getLanguageId() !== PPL_LANGUAGE_ID
    ) {
      return;
    }

    if (validationResult.errors.length > 0) {
      // A command-typo error carries a structured `fix`; collect those into the
      // syntax-fix side table (keyed by the marker fields Monaco preserves) so
      // the code-action provider can offer a one-click lightbulb. The fix is not
      // hung off the marker because Monaco's MarkerService rebuilds markers from
      // a fixed field list and drops custom properties — same constraint the
      // lint path handles via setModelFixes.
      const syntaxFixes = new Map<string, MarkerFix>();

      // Command-typo suggestion is a UX layer on the syntax channel, toggleable
      // via the same PPL-lint rules uiSetting (id `command-suggestion`). When it
      // is disabled we revert the friendly rewrite: use ANTLR's raw message and
      // drop the quick-fix, leaving the plain syntax error. The feature is also
      // gated on the global PPL-lint capability: when lint is off, no suggestion
      // enhancements fire (the raw syntax error still shows).
      const commandSuggestionEnabled =
        isPPLLintEnabled() && getPPLLintContext(model)?.commandSuggestionEnabled !== false;

      // Convert errors to Monaco markers
      const markers: monaco.editor.IMarkerData[] = validationResult.errors.map((error) => {
        // Map SyntaxError properties to Monaco marker properties
        const startLineNumber = error.line || 1;
        const endLineNumber = error.endLine || error.line || startLineNumber;
        const startColumn = (error.column || 0) + 1; // Monaco is 1-based, ANTLR is 0-based
        const endColumn = (error.endColumn || error.column + 1 || startColumn) + 1;

        const safeStartLine = Math.max(1, startLineNumber);
        const safeEndLine = Math.max(safeStartLine, endLineNumber);
        const safeStartColumn = Math.max(1, startColumn);
        const safeEndColumn = Math.max(safeStartColumn, endColumn);

        // A command-typo error is rewritten + carries a fix + keeps rawMessage.
        // When suggestions are off, fall back to the raw ANTLR message and no fix.
        const isSuppressedSuggestion =
          !commandSuggestionEnabled && error.code === 'UNKNOWN_COMMAND';
        const effectiveMessage = isSuppressedSuggestion
          ? (error.rawMessage ?? error.message)
          : error.message;
        const effectiveFix = isSuppressedSuggestion ? undefined : error.fix;

        const docLink = getPPLDocumentationLink(effectiveMessage);
        const marker: monaco.editor.IMarkerData = {
          severity: monaco.MarkerSeverity.Error,
          message: effectiveMessage,
          startLineNumber: safeStartLine,
          startColumn: safeStartColumn,
          endLineNumber: safeEndLine,
          endColumn: safeEndColumn,
          // Tag the channel so the code-action provider can serve syntax fixes
          // without touching lint markers.
          source: SYNTAX_MARKER_SOURCE,
          // Add error code for better categorization
          code: {
            value: 'View Documentation',
            target: monaco.Uri.parse(docLink.url),
          },
        };

        if (effectiveFix) {
          syntaxFixes.set(markerFixKey(marker), effectiveFix);
        }

        return marker;
      });

      setModelSyntaxFixes(model, syntaxFixes);
      monaco.editor.setModelMarkers(model, OWNER, markers);
    } else {
      // Clear markers and any stale syntax fixes if no errors
      clearModelSyntaxFixes(model);
      monaco.editor.setModelMarkers(model, OWNER, []);
    }
  } catch (error) {
    // Silent error handling - continue without worker-based highlighting
  }
};

export const revalidatePPLModel = async (model: monaco.editor.IModel) => {
  await processSyntaxHighlighting(model);
  processLintHighlighting(model);
};

/**
 * Process lint diagnostics for PPL models under the dedicated `PPL_LINT` marker
 * owner. Fire-and-forget: it never blocks or delays syntax-marker production
 * (R11.4) and never touches `PPL_WORKER` markers (R11.2). Gated by the
 * QUERY_ENHANCEMENTS_PPL_LINT setting (R1).
 */
const processLintHighlighting = (model: monaco.editor.IModel): void => {
  // Claim this pass's generation up front — even the early-return branches below
  // count, so a synchronous "clear markers" pass invalidates an in-flight async
  // response that would otherwise re-add stale markers after the clear.
  const generation = (lintGenerations.get(model.id) ?? 0) + 1;
  lintGenerations.set(model.id, generation);

  // Re-arm the per-pass hover / quick-fix-offered dedup at the START of the pass
  // — not in the terminal `.then` — so it is fresh before the first (possibly
  // progressive) marker set is published. The runtime bridge publishes markers
  // several times per pass (static, then explain-layered) and the hover / code-
  // action providers can act on them immediately; resetting only at pass end
  // meant interactions during that window were deduped against the *previous*
  // pass's keys and silently undercounted. A pass begins on a content or
  // language change (the debounced entry points below), which is exactly the
  // "fresh opportunity to count" boundary.
  resetPPLLintTelemetryDedup(model);

  if (!isPPLLintEnabled()) {
    monaco.editor.setModelMarkers(model, LINT_OWNER, []);
    clearModelFixes(model);
    clearModelHoverFacts(model);
    return;
  }

  if (model.getLanguageId() !== PPL_LANGUAGE_ID) {
    monaco.editor.setModelMarkers(model, LINT_OWNER, []);
    clearModelFixes(model);
    clearModelHoverFacts(model);
    return;
  }

  const content = model.getValue();

  const lintContext = getPPLLintContext(model);

  // True while this lint pass is still the authoritative one for the model — no
  // newer pass has started, the model is live, and its content/language have not
  // changed out from under us. Both the (possibly progressive) marker publisher
  // and the terminal telemetry step consult it so neither acts on a superseded
  // pass.
  const isPassCurrent = (): boolean =>
    lintGenerations.get(model.id) === generation &&
    !model.isDisposed() &&
    model.getValue() === content &&
    model.getLanguageId() === PPL_LANGUAGE_ID;

  const publishResult = (lintResult: LintResult): void => {
    // Drop a response that a newer lint pass has superseded (stale context or
    // stale content), so out-of-order worker responses can't clobber markers.
    if (!isPassCurrent()) {
      return;
    }
    const markers = lintResult.diagnostics.map((diagnostic) =>
      diagnosticToMarker(diagnostic, model.uri)
    );
    // Monaco's MarkerService rebuilds each marker from a fixed field list and
    // drops the custom `fix` / `hoverFacts` properties, so they would never
    // reach the code-action or hover providers. Capture each into a side table
    // keyed by the fields the service preserves, then strip them off the
    // marker before handing it over.
    const fixes = new Map<string, MarkerFix>();
    const hoverFacts = new Map<string, HoverFacts>();
    for (const marker of markers) {
      const withExtras = marker as monaco.editor.IMarkerData & {
        fix?: MarkerFix;
        hoverFacts?: HoverFacts;
      };
      const key = markerFixKey(marker);
      if (withExtras.fix) {
        fixes.set(key, withExtras.fix);
        delete withExtras.fix;
      }
      if (withExtras.hoverFacts) {
        hoverFacts.set(key, withExtras.hoverFacts);
        delete withExtras.hoverFacts;
      }
    }
    setModelFixes(model, fixes);
    setModelHoverFacts(model, hoverFacts);
    monaco.editor.setModelMarkers(model, LINT_OWNER, markers);
  };

  // Feature-usage telemetry for a completed lint pass. `publishResult` may run
  // several times within one pass (the runtime bridge renders progressively:
  // static markers first, then explain-layered), so telemetry lives here — in
  // the terminal `.then`, which runs exactly once per pass with the final,
  // authoritative diagnostics — not inside `publishResult`, to keep the "once
  // per rule per pass" contract. The per-pass dedup was already re-armed at the
  // start of the pass (see `resetPPLLintTelemetryDedup` above), so the hover /
  // offer counters are correct even during progressive rendering. No-ops until
  // the host registers a sink.
  const emitPassTelemetry = (lintResult: LintResult): void => {
    if (!isPassCurrent()) {
      return;
    }
    // One `diagnostic_shown` per distinct rule that produced a marker this pass,
    // so a query with three findings of the same rule counts once.
    const rulesShown = new Set<string>();
    for (const diagnostic of lintResult.diagnostics) {
      if (rulesShown.has(diagnostic.ruleId)) {
        continue;
      }
      rulesShown.add(diagnostic.ruleId);
      emitPPLLintTelemetry({
        name: PPL_LINT_TELEMETRY_EVENTS.DIAGNOSTIC_SHOWN,
        data: { rule: ruleLabel(diagnostic.ruleId) },
      });
    }
  };

  void resolvePPLLintResult(
    model,
    content,
    async (query) => lintCompiledPPL(query, lintContext),
    validateCompiledPPL,
    publishResult,
    async (query) => analyzeCompiledPPLLint(query, lintContext),
    validateCompiledPPLLintQueries
  )
    .then((lintResult) => {
      // Apply the final, authoritative marker set, then record once-per-pass
      // feature-usage telemetry for it.
      publishResult(lintResult);
      emitPassTelemetry(lintResult);
    })
    .catch(() => {
      // Lint is best-effort: never disrupt the editor on failure (R11.3).
    });
};

/**
 * Debounced wrapper for keystroke-driven lint. Restarts a 500ms trailing-edge
 * timer per model; only the last keystroke in a burst triggers actual lint work.
 */
const scheduleLintHighlighting = (model: monaco.editor.IModel): void => {
  const existing = lintDebounceTimers.get(model.id);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  const handle = setTimeout(() => {
    lintDebounceTimers.delete(model.id);
    processLintHighlighting(model);
  }, LINT_DEBOUNCE_MS);
  lintDebounceTimers.set(model.id, handle);
};

/**
 * Set up PPL document range formatting provider
 */
const setupPPLFormatter = () => {
  monaco.languages.registerDocumentRangeFormattingEditProvider(
    PPL_LANGUAGE_ID,
    pplRangeFormatProvider
  );
};

/**
 * Set up syntax highlighting using PPL worker
 */
const setupPPLSyntaxHighlighting = () => {
  const disposables: monaco.IDisposable[] = [];

  const handleModel = (model: monaco.editor.IModel) => {
    // Set up content change listener
    disposables.push(
      model.onDidChangeContent(async () => {
        if (model.getLanguageId() === PPL_LANGUAGE_ID) {
          await processSyntaxHighlighting(model);
          scheduleLintHighlighting(model);
        }
      })
    );

    // Set up language change listener
    disposables.push(
      model.onDidChangeLanguage(async () => {
        if (model.getLanguageId() === PPL_LANGUAGE_ID) {
          await processSyntaxHighlighting(model);
          processLintHighlighting(model);
        } else {
          monaco.editor.setModelMarkers(model, OWNER, []);
          monaco.editor.setModelMarkers(model, LINT_OWNER, []);
          clearModelFixes(model);
          clearModelSyntaxFixes(model);
          clearModelHoverFacts(model);
          resetPPLLintTelemetryDedup(model);
        }
      })
    );

    // Process immediately if already PPL
    if (model.getLanguageId() === PPL_LANGUAGE_ID) {
      processSyntaxHighlighting(model);
      processLintHighlighting(model);
    }
  };

  // Listen for new models
  disposables.push(monaco.editor.onDidCreateModel(handleModel));

  // Listen for model disposal to clear markers
  disposables.push(
    monaco.editor.onWillDisposeModel((model) => {
      const pending = lintDebounceTimers.get(model.id);
      if (pending !== undefined) {
        clearTimeout(pending);
        lintDebounceTimers.delete(model.id);
      }
      lintGenerations.delete(model.id);
      syntaxGenerations.delete(model.id);
      monaco.editor.setModelMarkers(model, OWNER, []);
      monaco.editor.setModelMarkers(model, LINT_OWNER, []);
      clearModelFixes(model);
      clearModelSyntaxFixes(model);
      clearModelHoverFacts(model);
      resetPPLLintTelemetryDedup(model);
    })
  );

  // Handle existing models
  monaco.editor.getModels().forEach(handleModel);

  // Return cleanup function
  return () => {
    lintDebounceTimers.forEach(clearTimeout);
    lintDebounceTimers.clear();
    disposables.forEach((d) => d.dispose());
    stopCompiledPPLWorker();
  };
};

/**
 * Register PPL language support with Monaco Editor
 */
export const registerPPLLanguage = () => {
  // Register the PPL language
  monaco.languages.register({
    id: PPL_LANGUAGE_ID,
    extensions: ['.ppl'],
    aliases: ['PPL', 'ppl', 'Piped Processing Language'],
    mimetypes: ['application/ppl', 'text/ppl'],
  });

  // Set language configuration
  monaco.languages.setLanguageConfiguration(PPL_LANGUAGE_ID, createPPLLanguageConfiguration());

  // Set up synchronous tokenization
  setupPPLTokenization();

  // Set up PPL formatter
  setupPPLFormatter();

  // Set up syntax highlighting with worker
  const disposeSyntaxHighlighting = setupPPLSyntaxHighlighting();

  // Register the lint quick-fix code-action provider
  const codeActionDisposable = monaco.languages.registerCodeActionProvider(
    PPL_LANGUAGE_ID,
    pplLintCodeActionProvider
  );

  // Register the AI ("Ask AI to fix") quick-fix command the provider's isAI
  // action dispatches. The handler packages the request for the host-owned chat
  // and confirmation/apply flow.
  const aiFixCommandDisposable = registerAiFixCommand();

  // Register the lint hover provider (the rich "view more" card). It reads
  // markers + the side tables lazily on hover, so it adds no per-lint cost.
  const hoverDisposable = monaco.languages.registerHoverProvider(
    PPL_LANGUAGE_ID,
    pplLintHoverProvider
  );

  // Register the command dispatched when a lint quick-fix is invoked. The
  // quick-fix action carries both an `edit` and this `command`; Monaco applies
  // the edit first, then runs the command, so recording here captures a genuine
  // "user clicked the fix" signal. The rule id and per-finding correlation id
  // ride on the command arguments (both already resolved by the code-action
  // provider, so `rule` is the sentinel-mapped label, never undefined).
  const quickfixCommandDisposable = monaco.editor.registerCommand(
    PPL_LINT_QUICKFIX_COMMAND_ID,
    (_accessor, args?: { rule?: string; marker?: string }) => {
      emitPPLLintTelemetry({
        name: PPL_LINT_TELEMETRY_EVENTS.QUICKFIX_CLICKED,
        data: { rule: ruleLabel(args?.rule), marker: args?.marker },
      });
    }
  );

  return {
    dispose: () => {
      disposeSyntaxHighlighting();
      codeActionDisposable.dispose();
      aiFixCommandDisposable.dispose();
      hoverDisposable.dispose();
      quickfixCommandDisposable.dispose();
    },
  };
};

// Auto-register PPL language support
registerPPLLanguage();
