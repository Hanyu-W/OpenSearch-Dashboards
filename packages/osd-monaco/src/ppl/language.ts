/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../monaco';
import { ID, PPL_TOKEN_SETS } from './constants';
import { PPLWorkerProxyService } from './worker_proxy_service';
import { getPPLLanguageAnalyzer, PPLValidationResult } from './ppl_language_analyzer';
import { getPPLDocumentationLink } from './ppl_documentation';
import { pplRangeFormatProvider } from './formatter';
import { resolvePPLValidationResult } from './validation_provider';
import { getPPLLintContext, isPPLLintEnabled, resolvePPLLintResult } from './lint_bridge';
import { LintResult } from './lint/diagnostic';
import { diagnosticToMarker } from './lint/diagnostic_to_marker';
import { pplLintCodeActionProvider } from './lint/code_action_provider';
import { clearModelFixes, markerFixKey, MarkerFix, setModelFixes } from './lint/fix_registry';
import { LINT_OWNER, pplLintHoverProvider } from './lint/hover/hover_provider';
import { clearModelHoverFacts, HoverFacts, setModelHoverFacts } from './lint/hover/hover_registry';

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

// PPL worker proxy service for worker-based syntax highlighting
const pplWorkerProxyService = new PPLWorkerProxyService();

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
    return;
  }

  try {
    const content = model.getValue();

    // Ensure worker is set up before validation - always call setup as it has internal check
    pplWorkerProxyService.setup();

    const validationResult = (await resolvePPLValidationResult(
      model,
      content,
      async (query) => (await pplWorkerProxyService.validate(query)) as PPLValidationResult
    )) as PPLValidationResult;

    if (validationResult.errors.length > 0) {
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

        const docLink = getPPLDocumentationLink(error.message);
        return {
          severity: monaco.MarkerSeverity.Error,
          message: error.message,
          startLineNumber: safeStartLine,
          startColumn: safeStartColumn,
          endLineNumber: safeEndLine,
          endColumn: safeEndColumn,
          // Add error code for better categorization
          code: {
            value: 'View Documentation',
            target: monaco.Uri.parse(docLink.url),
          },
        };
      });

      monaco.editor.setModelMarkers(model, OWNER, markers);
    } else {
      // Clear markers if no errors
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

  pplWorkerProxyService.setup();

  // The compiled fallback runs in a web worker with no uiSettings client, so
  // read the per-model overrides here on the main thread and forward them.
  const overrides = getPPLLintContext(model)?.overrides;

  void resolvePPLLintResult(
    model,
    content,
    async (query) => (await pplWorkerProxyService.lint(query, overrides)) as LintResult
  )
    .then((lintResult: LintResult) => {
      // Drop a response that a newer lint pass has superseded (stale context or
      // stale content), so out-of-order worker responses can't clobber markers.
      if (
        lintGenerations.get(model.id) !== generation ||
        model.isDisposed() ||
        model.getValue() !== content
      ) {
        return;
      }
      if (model.getLanguageId() !== PPL_LANGUAGE_ID) {
        return;
      }
      const markers = lintResult.diagnostics.map(diagnosticToMarker);
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
          clearModelHoverFacts(model);
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
      monaco.editor.setModelMarkers(model, OWNER, []);
      monaco.editor.setModelMarkers(model, LINT_OWNER, []);
      clearModelFixes(model);
      clearModelHoverFacts(model);
    })
  );

  // Handle existing models
  monaco.editor.getModels().forEach(handleModel);

  // Return cleanup function
  return () => {
    lintDebounceTimers.forEach(clearTimeout);
    lintDebounceTimers.clear();
    disposables.forEach((d) => d.dispose());
    pplWorkerProxyService.stop();
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

  // Register the lint hover provider (the rich "view more" card). It reads
  // markers + the side tables lazily on hover, so it adds no per-lint cost.
  const hoverDisposable = monaco.languages.registerHoverProvider(
    PPL_LANGUAGE_ID,
    pplLintHoverProvider
  );

  return {
    dispose: () => {
      disposeSyntaxHighlighting();
      codeActionDisposable.dispose();
      hoverDisposable.dispose();
    },
  };
};

// Auto-register PPL language support
registerPPLLanguage();
