/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { monaco, PPLValidationContext, PPLLintContext, revalidatePPLModel } from '@osd/monaco';
import { useDispatch, useSelector } from 'react-redux';
import { i18n } from '@osd/i18n';
import { DEFAULT_DATA } from '../../../../../../data/common';
import {
  selectIsPromptEditorMode,
  selectPromptModeIsAvailable,
  selectQueryLanguage,
  selectQueryString,
  selectIsQueryEditorDirty,
  selectDataset,
} from '../../../../application/utils/state_management/selectors';
import { promptEditorOptions, queryEditorOptions } from './editor_options';

import { useEditorRef } from '../../../../application/hooks';
import { useLanguageSwitch } from '../../../../application/hooks/editor_hooks/use_switch_language';
import { useOpenSearchDashboards } from '../../../../../../opensearch_dashboards_react/public';
import { ExploreServices } from '../../../../types';
import { getEffectiveLanguageForAutoComplete } from '../../../../../../data/public';
import { onEditorRunActionCreator } from '../../../../application/utils/state_management/actions/query_editor';
import { getCommandEnterAction } from './command_enter_action';
import { getShiftEnterAction } from './shift_enter_action';
import { getTabAction } from './tab_action';
import { getEnterAction } from './enter_action';
import { getSpacebarAction } from './spacebar_action';
import { setIsQueryEditorDirty } from '../../../../application/utils/state_management/slices/query_editor/query_editor_slice';
import { getEscapeAction } from './escape_action';
import { usePromptIsTyping } from './use_prompt_is_typing';
import { EditorMode } from '../../../../application/utils/state_management/types';
import { useMultiQueryDecorations } from './use_multi_query_decorations';
import { getAutocompleteContext } from '../../../../application/utils/multi_query_utils';
import {
  attachPPLValidationContext,
  attachPPLGrammarRefresh,
  syncPPLValidationContext,
  attachPPLLintContext,
  attachPPLLintGrammarRefresh,
  syncPPLLintContext,
  pplGrammarCache,
  shouldUseRuntimeGrammar,
  deriveIsCalcite,
  collectDisabledObjectFields,
  calciteSettingsCache,
  buildOverridesFromSettings,
  fetchVisibleIndices,
} from '../../../../../../data/public';

type IStandaloneCodeEditor = monaco.editor.IStandaloneCodeEditor;
type LanguageConfiguration = monaco.languages.LanguageConfiguration;
type IEditorConstructionOptions = monaco.editor.IEditorConstructionOptions;

export const DEFAULT_TRIGGER_CHARACTERS = [' ', '=', "'", '"', '`', '$'];

export const languageConfiguration: LanguageConfiguration = {
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
  ],
  comments: {
    lineComment: '//', // line comment
    blockComment: ['/*', '*/'], // block comment
  },
  wordPattern: /@?\w[\w@'.-]*[?!,;:"]*/, // Consider tokens containing . @ as words while applying suggestions. Refer https://github.com/opensearch-project/OpenSearch-Dashboards/pull/10118#discussion_r2201428532 for details.
};

export interface UseQueryPanelEditorReturnType {
  editorDidMount: (editor: IStandaloneCodeEditor) => () => IStandaloneCodeEditor;
  isFocused: boolean;
  isPromptMode: boolean;
  languageConfiguration: LanguageConfiguration;
  languageId: string;
  onChange: (text: string) => void;
  onEditorClick: () => void;
  options: IEditorConstructionOptions;
  placeholder: string;
  promptIsTyping: boolean;
  suggestionProvider: monaco.languages.CompletionItemProvider;
  showPlaceholder: boolean;
  useLatestTheme: true;
  value: string;
}

export const useQueryPanelEditor = (): UseQueryPanelEditorReturnType => {
  const { promptIsTyping, handleChangeForPromptIsTyping } = usePromptIsTyping();
  const promptModeIsAvailable = useSelector(selectPromptModeIsAvailable);
  const { services } = useOpenSearchDashboards<ExploreServices>();
  const { keyboardShortcut } = services;
  const userQueryString = useSelector(selectQueryString);
  const [editorText, setEditorText] = useState<string>(userQueryString);
  const [editorIsFocused, setEditorIsFocused] = useState(false);
  const {
    data: {
      dataViews,
      query: { queryString },
    },
  } = services;
  const { updateDecorations, clearDecorations } = useMultiQueryDecorations();
  // The 'onRun' functions in editorDidMount uses the context values when the editor is mounted.
  // Using a ref will ensure it always uses the latest value
  const editorTextRef = useRef(editorText);
  const queryLanguage = useSelector(selectQueryLanguage);
  const languageTitle = useMemo(() => {
    const languageService = services.data.query.queryString.getLanguageService();
    return languageService.getLanguage(queryLanguage)?.title ?? queryLanguage;
  }, [queryLanguage, services.data.query.queryString]);
  const dispatch = useDispatch();
  const editorRef = useEditorRef();
  const isPromptMode = useSelector(selectIsPromptEditorMode);
  const isQueryMode = !isPromptMode;
  const isPromptModeRef = useRef(isPromptMode);
  const promptModeIsAvailableRef = useRef(promptModeIsAvailable);
  const queryLanguageRef = useRef(queryLanguage);
  const isQueryEditorDirty = useSelector(selectIsQueryEditorDirty);
  const dataset = useSelector(selectDataset);
  // Always-current view of the active dataset. The grammar-refresh listener
  // captures getLintContext / getValidationContext once at editorDidMount; a
  // ref keeps those closures reading the latest dataset (mirrors caller A's
  // queryRef pattern) instead of a transiently dataset-less queryString.getQuery().
  const datasetRef = useRef(dataset);
  const detachValidationContextRef = useRef<(() => void) | undefined>();
  const detachGrammarRefreshRef = useRef<(() => void) | undefined>();
  const detachLintContextRef = useRef<(() => void) | undefined>();
  const detachLintGrammarRefreshRef = useRef<(() => void) | undefined>();
  // Cache of derived field metadata per dataset id, populated asynchronously.
  // Field-aware lint rules self-suppress until this resolves.
  const lintFieldsRef = useRef<{
    datasetId?: string;
    fields?: Set<string>;
    typeMap?: Map<string, string>;
    disabledObjectFields?: Set<string>;
    visibleIndices?: string[];
  }>({});

  const getValidationContext = useCallback((): PPLValidationContext => {
    const ds = datasetRef.current;
    const dsId = ds?.dataSource?.id;
    const dsVersion = ds?.dataSource?.version;
    return {
      useRuntimeGrammar: shouldUseRuntimeGrammar(dsId, dsVersion),
      dataSourceId: dsId,
      dataSourceVersion: dsVersion,
    };
  }, []);

  const getLintContext = useCallback((): PPLLintContext => {
    const ds = datasetRef.current;
    const dsId = ds?.dataSource?.id;
    const dsVersion = ds?.dataSource?.version;
    const cached = lintFieldsRef.current;
    // Only feed cached field metadata to the lint rules when it belongs to the
    // dataset the query currently targets. After a dataset switch the async
    // field load for the new dataset has not resolved yet, so the cache still
    // holds the previous dataset's fields — using them would make field-aware
    // rules fire against the wrong index. When they don't match, omit them so
    // those rules self-suppress until the new load resolves.
    const cacheMatchesDataset = cached.datasetId === ds?.id;
    const calcite = calciteSettingsCache.getCached(dsId);
    return {
      useRuntimeGrammar: shouldUseRuntimeGrammar(dsId, dsVersion),
      dataSourceId: dsId,
      dataSourceVersion: dsVersion,
      isCalcite: calcite?.isCalcite ?? deriveIsCalcite(dsVersion),
      settings: { allJoinTypesAllowed: calcite?.allJoinTypesAllowed ?? false },
      fields: cacheMatchesDataset ? cached.fields : undefined,
      typeMap: cacheMatchesDataset ? cached.typeMap : undefined,
      disabledObjectFields: cacheMatchesDataset ? cached.disabledObjectFields : undefined,
      visibleIndices: cacheMatchesDataset ? cached.visibleIndices : undefined,
      overrides: buildOverridesFromSettings(services.uiSettings),
    };
  }, [services.uiSettings]);

  const switchEditorMode = useLanguageSwitch();

  // Keep the refs updated with latest context
  useEffect(() => {
    editorTextRef.current = editorText;
  }, [editorText]);
  useEffect(() => {
    isPromptModeRef.current = isPromptMode;
  }, [isPromptMode]);
  useEffect(() => {
    promptModeIsAvailableRef.current = promptModeIsAvailable;
  }, [promptModeIsAvailable]);
  useEffect(() => {
    queryLanguageRef.current = queryLanguage;
  }, [queryLanguage]);
  useEffect(() => {
    datasetRef.current = dataset;
  }, [dataset]);

  // Sync editor text when Redux query string changes externally (e.g., language switch)
  useEffect(() => {
    if (userQueryString !== editorText) {
      setEditorText(userQueryString);
      editorRef.current?.setValue(userQueryString);
    }
    // Only react to external Redux changes, not local edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userQueryString]);

  // Sync PPL validation context when datasource changes
  useEffect(() => {
    const dsId = dataset?.dataSource?.id;
    const dsVersion = dataset?.dataSource?.version;
    syncPPLValidationContext(editorRef.current, {
      useRuntimeGrammar: shouldUseRuntimeGrammar(dsId, dsVersion),
      dataSourceId: dsId,
      dataSourceVersion: dsVersion,
    });
    const model = editorRef.current?.getModel();
    if (model) {
      void revalidatePPLModel(model);
    }
  }, [dataset?.dataSource?.id, dataset?.dataSource?.version, editorRef]);

  // Load field metadata for the active dataset and feed it to the lint context.
  // Field-aware lint rules self-suppress until this resolves, so the context is
  // set in a single phase after the async load to avoid flicker. Mirrors the
  // data plugin's query editor wiring so lint behaves the same on every editor.
  useEffect(() => {
    const datasetId = dataset?.id;
    const dsId = dataset?.dataSource?.id;
    const dsVersion = dataset?.dataSource?.version;
    let cancelled = false;

    const syncLint = () => {
      const calcite = calciteSettingsCache.getCached(dsId);
      syncPPLLintContext(editorRef.current, {
        useRuntimeGrammar: shouldUseRuntimeGrammar(dsId, dsVersion),
        dataSourceId: dsId,
        dataSourceVersion: dsVersion,
        isCalcite: calcite?.isCalcite ?? deriveIsCalcite(dsVersion),
        settings: { allJoinTypesAllowed: calcite?.allJoinTypesAllowed ?? false },
        fields: lintFieldsRef.current.fields,
        typeMap: lintFieldsRef.current.typeMap,
        disabledObjectFields: lintFieldsRef.current.disabledObjectFields,
        visibleIndices: lintFieldsRef.current.visibleIndices,
        overrides: buildOverridesFromSettings(services.uiSettings),
      });
      const model = editorRef.current?.getModel();
      if (model) {
        void revalidatePPLModel(model);
      }
    };

    // Best-effort fetch of object fields mapped `enabled: false`. The attribute
    // is stripped by `_field_caps` (so it never appears in `indexPattern.fields`)
    // and must be read from `_mappings`. Rather than a dedicated endpoint, this
    // calls the existing read-only DSL mapping route (which proxies
    // `indices.getMapping`) and walks the response client-side. Returns undefined
    // on any failure so the `enabled-false-object` rule self-suppresses rather
    // than false-firing.
    const loadDisabledObjectFields = async (indexPattern: {
      title?: string;
      dataSourceRef?: { id?: string };
    }): Promise<Set<string> | undefined> => {
      const pattern = indexPattern.title;
      if (!pattern || !services.http) {
        return undefined;
      }
      try {
        const DSL_MAPPING_URL = '/api/directquery/dsl/indices.getFieldMapping';
        const mdsId = indexPattern.dataSourceRef?.id;
        const url = mdsId
          ? `${DSL_MAPPING_URL}/dataSourceMDSId=${encodeURIComponent(mdsId)}`
          : DSL_MAPPING_URL;
        const resp = await services.http.get(url, {
          query: { index: pattern },
        });
        const fields = collectDisabledObjectFields(resp);
        return fields.length > 0 ? new Set(fields) : undefined;
      } catch {
        return undefined;
      }
    };

    const loadFields = async () => {
      if (!datasetId) {
        // No dataset selected: drop any cached fields so field-aware rules
        // self-suppress instead of running against the previous dataset's
        // metadata, then push the cleared context.
        lintFieldsRef.current = {};
        syncLint();
        return;
      }
      try {
        // `onlyCheckCache` is intentionally false: a `true` cache-only fetch
        // returns undefined on a miss (for non-index-pattern datasets), which
        // would throw on the field walk below.
        const indexPattern = await dataViews.get(datasetId);
        if (cancelled || !indexPattern) {
          return;
        }
        const fields = new Set<string>();
        const typeMap = new Map<string, string>();
        for (const field of indexPattern.fields ?? []) {
          if (!field?.name) {
            continue;
          }
          fields.add(field.name);
          const esType = field.esTypes?.[0];
          if (esType) {
            typeMap.set(field.name, esType);
          }
        }
        // Fetch the visible-index list (for wildcard-source-zero-match)
        // concurrently with the disabled-object-fields walk so both gate the
        // same single-phase context update below.
        const [disabledObjectFields, visibleIndices] = await Promise.all([
          loadDisabledObjectFields(indexPattern),
          services.http ? fetchVisibleIndices(services.http, dsId) : Promise.resolve([]),
        ]);
        if (cancelled) {
          return;
        }
        lintFieldsRef.current = {
          datasetId,
          fields,
          typeMap,
          disabledObjectFields,
          visibleIndices,
        };
        // Single-phase update after the async load resolves.
        syncLint();
      } catch {
        // On failure, leave fields unset so field-aware rules self-suppress.
      }
    };

    void loadFields();

    if (services.http) {
      calciteSettingsCache.resolve(services.http, dsId).then(() => {
        if (!cancelled) syncLint();
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    dataset?.id,
    dataset?.dataSource?.id,
    dataset?.dataSource?.version,
    dataViews,
    editorRef,
    services.http,
    services.uiSettings,
  ]);

  // Cleanup validation + lint context on unmount
  useEffect(
    () => () => {
      detachValidationContextRef.current?.();
      detachValidationContextRef.current = undefined;
      detachGrammarRefreshRef.current?.();
      detachGrammarRefreshRef.current = undefined;
      detachLintContextRef.current?.();
      detachLintContextRef.current = undefined;
      detachLintGrammarRefreshRef.current?.();
      detachLintGrammarRefreshRef.current = undefined;
    },
    []
  );

  const focusExploreQueryBar = useCallback(() => {
    editorRef.current?.focus();
  }, [editorRef]);

  keyboardShortcut?.useKeyboardShortcut({
    id: 'focus_explore_query_bar',
    pluginId: 'explore',
    name: i18n.translate('explore.queryPanelEditor.focusQueryBarShortcut', {
      defaultMessage: 'Focus query bar',
    }),
    category: i18n.translate('explore.queryPanelEditor.searchCategory', {
      defaultMessage: 'Search',
    }),
    keys: '/',
    execute: focusExploreQueryBar,
  });

  // The 'triggerSuggestOnFocus' prop of CodeEditor only happens on mount, so I am intentionally not passing it
  // and programmatically doing it here. We should only trigger autosuggestion on focus while on isQueryMode and there is text
  useEffect(() => {
    if (isQueryMode) {
      const onDidFocusDisposable = editorRef.current?.onDidFocusEditorWidget(() => {
        editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
      });

      if (!editorText) {
        editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
      }

      return () => {
        onDidFocusDisposable?.dispose();
      };
    }
  }, [isQueryMode, editorRef, editorText]);

  const setEditorRef = useCallback(
    (editor: IStandaloneCodeEditor) => {
      editorRef.current = editor;
    },
    [editorRef]
  );

  // Real autocomplete implementation using the data plugin's autocomplete service
  const provideCompletionItems = useCallback(
    async (
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      _: monaco.languages.CompletionContext,
      token: monaco.CancellationToken
    ): Promise<monaco.languages.CompletionList> => {
      if (token.isCancellationRequested) {
        return { suggestions: [], incomplete: false };
      }
      try {
        // Get the effective language for autocomplete (PPL -> PPL_Simplified for explore app)
        const effectiveLanguage = getEffectiveLanguageForAutoComplete(
          isPromptModeRef.current ? 'AI' : queryLanguage,
          'explore'
        );

        // Get the current dataset from Query Service to avoid stale closure values
        const currentDataset = queryString.getQuery().dataset;
        const currentDataView = await dataViews.get(
          currentDataset?.id!,
          currentDataset?.type !== DEFAULT_DATA.SET_TYPES.INDEX_PATTERN
        );

        const autocompleteCtx = getAutocompleteContext(
          model.getValue(),
          model.getOffsetAt(position),
          position.lineNumber,
          position.column,
          queryLanguage
        );

        // Use the current Dataset to avoid stale data
        const suggestions = await services?.data?.autocomplete?.getQuerySuggestions({
          query: autocompleteCtx.queryText,
          selectionStart: autocompleteCtx.selectionStart,
          selectionEnd: autocompleteCtx.selectionEnd,
          language: effectiveLanguage,
          baseLanguage: queryLanguage, // Pass the original language before transformation
          indexPattern: currentDataView,
          datasetType: currentDataset?.type,
          position: new monaco.Position(autocompleteCtx.lineNumber, autocompleteCtx.column),
          services: services as any, // ExploreServices storage type incompatible with IDataPluginServices.DataStorage
        });

        // current completion item range being given as last 'word' at pos
        const wordUntil = model.getWordUntilPosition(position);

        const defaultRange = new monaco.Range(
          position.lineNumber,
          wordUntil.startColumn,
          position.lineNumber,
          wordUntil.endColumn
        );

        const filteredSuggestions = suggestions?.filter((s) => 'detail' in s) || [];

        const monacoSuggestions = filteredSuggestions.map((s: any) => ({
          label: s.text,
          kind: s.type as monaco.languages.CompletionItemKind,
          insertText: s.insertText ?? s.text,
          insertTextRules: s.insertTextRules ?? undefined,
          range: defaultRange,
          detail: s.detail,
          sortText: s.sortText,
          documentation: s.documentation
            ? {
                value: s.documentation,
                isTrusted: true,
              }
            : '',
          command: {
            id: 'editor.action.triggerSuggest',
            title: 'Trigger Next Suggestion',
          },
        }));

        return {
          suggestions: monacoSuggestions,
          incomplete: false,
        };
      } catch (autocompleteError) {
        return { suggestions: [], incomplete: false };
      }
    },
    [isPromptModeRef, queryLanguage, queryString, dataViews, services]
  );

  const suggestionProvider = useMemo(() => {
    const languageTriggerCharacters = services?.data?.autocomplete?.getTriggerCharacters(
      queryLanguage
    );
    return {
      triggerCharacters: isPromptMode
        ? ['=']
        : languageTriggerCharacters ?? DEFAULT_TRIGGER_CHARACTERS,
      provideCompletionItems,
    };
  }, [isPromptMode, provideCompletionItems, queryLanguage, services]);

  const handleRun = useCallback(() => {
    // @ts-expect-error TS2345 TODO(ts-error): fixme
    dispatch(onEditorRunActionCreator(services, editorTextRef.current));
  }, [dispatch, services]);

  const editorDidMount = useCallback(
    (editor: IStandaloneCodeEditor) => {
      setEditorRef(editor);

      // Attach PPL runtime validation context
      detachValidationContextRef.current?.();
      detachGrammarRefreshRef.current?.();
      detachValidationContextRef.current = attachPPLValidationContext(editor, getValidationContext);
      detachGrammarRefreshRef.current = attachPPLGrammarRefresh(
        editor,
        getValidationContext,
        (listener) => pplGrammarCache.subscribeToGrammarUpdates(listener),
        revalidatePPLModel
      );

      // Attach PPL lint context so field-aware lint rules (which self-suppress
      // without field metadata) run here just as they do in the data plugin's
      // query editor. The field metadata itself is loaded by the dataset effect.
      detachLintContextRef.current?.();
      detachLintGrammarRefreshRef.current?.();
      detachLintContextRef.current = attachPPLLintContext(editor, getLintContext);
      detachLintGrammarRefreshRef.current = attachPPLLintGrammarRefresh(
        editor,
        getLintContext,
        (listener) => pplGrammarCache.subscribeToGrammarUpdates(listener),
        revalidatePPLModel
      );

      // Revalidate immediately so any initial content that was validated before
      // the context was attached gets re-checked with the runtime grammar.
      const model = editor.getModel();
      if (model) {
        void revalidatePPLModel(model);
      }

      const focusDisposable = editor.onDidFocusEditorText(() => {
        setEditorIsFocused(true);
      });
      const blurDisposable = editor.onDidBlurEditorText(() => {
        setEditorIsFocused(false);
      });

      editor.addAction(getCommandEnterAction(handleRun));
      editor.addAction(getShiftEnterAction());

      // Add Tab key handling to trigger next autosuggestions after selection
      editor.addAction(getTabAction());

      // Add Enter key handling for suggestions
      editor.addAction(getEnterAction(handleRun));

      // Add Space bar key handling to switch to prompt mode
      editor.addAction(
        getSpacebarAction(promptModeIsAvailableRef, isPromptModeRef, editorTextRef, () =>
          switchEditorMode(EditorMode.Prompt)
        )
      );

      // Add Escape key handling to switch to query mode
      editor.addAction(getEscapeAction(isPromptModeRef, () => switchEditorMode(EditorMode.Query)));

      // Apply multi-query decorations on mount
      updateDecorations(editor, queryLanguageRef.current);

      // Update decorations when content changes
      const contentChangeDisposable = editor.onDidChangeModelContent(() => {
        updateDecorations(editor, queryLanguageRef.current);
      });

      editor.onDidContentSizeChange(() => {
        const contentHeight = editor.getContentHeight();
        // Read the resizable panel's allocated height rather than the editor's
        // immediate parent, which may have been pushed taller by content.
        const domNode = editor.getDomNode();
        const panelEl = domNode?.closest('.exploreResizableQueryContainer__queryPanel');
        const containerHeight =
          panelEl?.clientHeight ?? domNode?.parentElement?.clientHeight ?? 100;
        const maxHeight = Math.max(containerHeight, 36);
        const finalHeight = Math.min(contentHeight, maxHeight);

        editor.layout({
          width: editor.getLayoutInfo().width,
          height: finalHeight,
        });
        editor.updateOptions({
          scrollBeyondLastLine: false,
          scrollbar: {
            vertical: contentHeight > maxHeight ? 'visible' : 'hidden',
          },
        });

        // Automatically scroll to the bottom when new lines are added
        if (contentHeight > finalHeight) {
          const cursorLine = editor.getPosition()?.lineNumber || 0;
          const visibleRanges = editor.getVisibleRanges();

          if (visibleRanges.length > 0) {
            // use index 0 since we did not introduce code folding in our monaco editor
            const firstVisibleLine = visibleRanges[0].startLineNumber;
            const lastVisibleLine = visibleRanges[0].endLineNumber;

            // Only reveal if cursor is outside the visible range
            if (cursorLine < firstVisibleLine || cursorLine > lastVisibleLine) {
              editor.revealLine(cursorLine);
            }
          }
        }
      });

      return () => {
        focusDisposable.dispose();
        blurDisposable.dispose();
        contentChangeDisposable.dispose();
        clearDecorations(editor);
        return editor;
      };
    },
    [
      setEditorRef,
      handleRun,
      switchEditorMode,
      setEditorIsFocused,
      updateDecorations,
      clearDecorations,
      getValidationContext,
      getLintContext,
    ]
  );

  const options = useMemo(() => {
    if (isQueryMode) {
      return queryEditorOptions;
    } else {
      return promptEditorOptions;
    }
  }, [isQueryMode]);

  const placeholder = useMemo(() => {
    const enabledPromptPlaceholder = i18n.translate(
      'explore.queryPanel.queryPanelEditor.enabledPromptPlaceholder',
      {
        defaultMessage: 'Press `space` to Ask AI with natural language, or search with {language}',
        values: {
          language: languageTitle,
        },
      }
    );
    const disabledPromptPlaceholder = i18n.translate(
      'explore.queryPanel.queryPanelEditor.disabledPromptPlaceholder',
      {
        defaultMessage: 'Search using {symbol} {language}',
        values: {
          symbol: '</>',
          language: languageTitle,
        },
      }
    );
    const promptModePlaceholder = i18n.translate(
      'explore.queryPanel.queryPanelEditor.promptPlaceholder',
      {
        defaultMessage: 'Ask AI with natural language. `Esc` to clear and search with {language}',
        values: {
          language: languageTitle,
        },
      }
    );

    if (!promptModeIsAvailable) {
      return disabledPromptPlaceholder;
    }

    return isPromptMode ? promptModePlaceholder : enabledPromptPlaceholder;
  }, [isPromptMode, promptModeIsAvailable, languageTitle]);

  const onEditorClick = useCallback(() => {
    editorRef.current?.focus();
  }, [editorRef]);

  const onChange = useCallback(
    (newText: string) => {
      setEditorText(newText);

      if (!isQueryEditorDirty) {
        dispatch(setIsQueryEditorDirty(true));
      }

      if (isPromptMode) {
        handleChangeForPromptIsTyping();
      }
    },
    [setEditorText, isPromptMode, handleChangeForPromptIsTyping, isQueryEditorDirty, dispatch]
  );

  return {
    editorDidMount,
    isFocused: editorIsFocused,
    isPromptMode,
    languageConfiguration,
    languageId: isPromptMode ? 'AI' : queryLanguage,
    onChange,
    onEditorClick,
    options,
    placeholder,
    promptIsTyping,
    suggestionProvider,
    showPlaceholder: !editorText.length,
    useLatestTheme: true,
    value: editorText,
  };
};
