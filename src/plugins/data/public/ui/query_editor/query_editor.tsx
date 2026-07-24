/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { i18n } from '@osd/i18n';

import {
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCompressedFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiText,
  PopoverAnchorPosition,
} from '@elastic/eui';
import classNames from 'classnames';
import React, { useEffect, useRef, useState } from 'react';
import { monaco, PPLValidationContext, PPLLintContext, revalidatePPLModel } from '@osd/monaco';
import {
  IDataPluginServices,
  Query,
  TimeRange,
  QueryControls,
  RecentQueriesTable,
  QueryResult,
  QueryStatus,
  useQueryStringManager,
  UI_SETTINGS,
} from '../..';
import { OpenSearchDashboardsReactContextValue } from '../../../../opensearch_dashboards_react/public';
import { fromUser, getQueryLog, PersistedLog, toUser } from '../../query';
import { SuggestionsListSize } from '../typeahead/suggestions_component';
import { QueryLanguageSelector } from './language_selector';
import { QueryEditorExtensions } from './query_editor_extensions';
import { getQueryService, getIndexPatterns } from '../../services';
import { DefaultInputProps } from './editors';
import { MonacoCompatibleQuerySuggestion } from '../../autocomplete/providers/query_suggestion_provider';
import { getEffectiveLanguageForAutoComplete } from './utils';
import {
  pplGrammarCache,
  shouldUseRuntimeGrammar,
} from '../../antlr/opensearch_ppl/ppl_grammar_cache';
import { syncPPLValidationContext } from './validation_context';
import {
  syncPPLLintContext,
  attachPPLContexts,
  cleanupPPLContexts,
  PPLDetachRefs,
} from './lint_context';
import { buildPPLLintContext, LintFieldsCache } from '../../ppl_lint/lint_context_builder';
import { fetchDisabledObjectFields } from '../../ppl_lint/disabled_object_fields';
import { calciteSettingsCache } from '../../ppl_lint/calcite_settings';
import { fetchVisibleIndices } from '../../ppl_lint/visible_indices';
import { getAiAgentAvailableForDataSource } from '../../ppl_lint/ai_agent_availability';
import { storePPLLintFixSession } from '../../chat_tools/ppl_lint_fix_session';
import type { AskPPLLintFixRequest } from '../../chat_tools/ppl_lint_fix_session';
import { addPPLLintFixAssistantContext, PPLLintFixLifecycle } from './ppl_lint_fix_lifecycle';

export interface QueryEditorProps {
  query: Query;
  disableAutoFocus?: boolean;
  screenTitle?: string;
  queryActions?: any;
  persistedLog?: PersistedLog;
  bubbleSubmitEvent?: boolean;
  placeholder?: string;
  languageSwitcherPopoverAnchorPosition?: PopoverAnchorPosition;
  onBlur?: () => void;
  onChange?: (query: Query, dateRange?: TimeRange) => void;
  onChangeQueryEditorFocus?: (isFocused: boolean) => void;
  onSubmit?: (query: Query, dateRange?: TimeRange) => void;
  dataTestSubj?: string;
  size?: SuggestionsListSize;
  className?: string;
  isInvalid?: boolean;
  headerClassName?: string;
  bannerClassName?: string;
  footerClassName?: string;
  filterBar?: any;
  prepend?: React.ComponentProps<typeof EuiCompressedFieldText>['prepend'];
  savedQueryManagement?: any;
  queryStatus?: QueryStatus;
}

interface Props extends QueryEditorProps {
  opensearchDashboards: OpenSearchDashboardsReactContextValue<IDataPluginServices>;
}

interface PPLLintFixServiceCapability {
  pplLintFixToolName?: string;
}

export const QueryEditorUI: React.FC<Props> = (props) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [lineCount, setLineCount] = useState<number | undefined>(undefined);
  const [isRecentQueryVisible, setIsRecentQueryVisible] = useState(false);
  const [currentAppId, setCurrentAppId] = useState<string>(''); // Add app ID state

  const inputRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The four PPL validation + lint detach callbacks, bundled so attach/cleanup
  // can thread them as one unit (see attachPPLContexts / cleanupPPLContexts).
  const detachRefs = useRef<PPLDetachRefs>({
    validationContext: { current: undefined },
    grammarRefresh: { current: undefined },
    lintContext: { current: undefined },
    lintGrammarRefresh: { current: undefined },
    lintHoverPersistence: { current: undefined },
  });
  // Cache of derived field metadata per dataset id, populated asynchronously.
  const lintFieldsRef = useRef<LintFieldsCache>({});
  const headerRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const bottomPanelRef = useRef<HTMLDivElement>(null);
  const queryControlsContainer = useRef<HTMLDivElement>(null);
  // TODO: https://github.com/opensearch-project/OpenSearch-Dashboards/issues/8801
  const editorQuery = props.query; // local query state managed by the editor. Not to be confused by the app query state.

  const queryString = getQueryService().queryString;
  const timefilter = getQueryService().timefilter.timefilter;
  const languageManager = queryString.getLanguageService();
  const extensionMap = languageManager.getQueryEditorExtensionMap();
  const services = props.opensearchDashboards.services;
  const pplLintFixLifecycleRef = useRef<PPLLintFixLifecycle>();
  if (!pplLintFixLifecycleRef.current) {
    pplLintFixLifecycleRef.current = new PPLLintFixLifecycle((contextId) => {
      services.contextProvider?.getAssistantContextStore()?.removeContextById(contextId);
    });
  }
  const pplLintFixLifecycle = pplLintFixLifecycleRef.current;
  const { query } = useQueryStringManager({
    queryString,
  });
  const queryRef = useRef(query);

  // Monaco commands are registered once at startup, we need a ref to access the latest query state inside command callbacks
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const persistedLogRef = useRef<PersistedLog>(
    props.persistedLog ||
      getQueryLog(services.uiSettings, services.storage, services.appName, query.language)
  );
  const abortControllerRef = useRef<AbortController>();

  useEffect(() => {
    const abortController = abortControllerRef.current;
    return () => {
      if (abortController) {
        abortController.abort();
      }
    };
  }, []);

  const getValidationContext = (): PPLValidationContext => {
    const dsId = queryRef.current.dataset?.dataSource?.id;
    const dsVersion = queryRef.current.dataset?.dataSource?.version;
    return {
      useRuntimeGrammar: shouldUseRuntimeGrammar(dsId, dsVersion),
      dataSourceId: dsId,
      dataSourceVersion: dsVersion,
    };
  };

  function onAskAiFix(request: AskPPLLintFixRequest): void {
    pplLintFixLifecycle.beginRequest(request.requestId);
    const session = {
      request,
      getCurrentQuery: () => inputRef.current?.getValue() ?? toUser(queryRef.current.query),
      getCurrentQueryState: () => queryString.getQuery(),
      getLintContext,
    };

    const chat = services.chat;
    if (!chat?.sendMessageWithWindow || !(chat.isAvailable?.() ?? true)) {
      pplLintFixLifecycle.abandonRequest(request.requestId);
      services.notifications.toasts.addWarning(
        i18n.translate('data.pplLint.aiFix.chatUnavailable', {
          defaultMessage: 'AI is not available for this PPL lint fix.',
        })
      );
      return;
    }

    // Send the fix request's machine plumbing (correlation ids + tool-calling
    // instructions) out-of-band via the assistant context store so the model
    // receives it without it rendering as a chat bubble. The visible bubble is
    // the short human message (request.chatMessage). Keyed by requestId.
    const contextStore = services.contextProvider?.getAssistantContextStore?.();
    addPPLLintFixAssistantContext(request, contextStore);

    void pplLintFixLifecycle
      .waitForChatLaunch(request.requestId, () =>
        chat.sendMessageWithWindow!(request.chatMessage, [], { clearConversation: true })
      )
      .then((failure) => {
        if (!failure) {
          // Activate only after the fresh chat reset so an older card cannot
          // capture this request while its previous conversation is still live.
          if (pplLintFixLifecycle.ownsRequest(request.requestId)) {
            storePPLLintFixSession({
              ...session,
              chatThreadId: chat.getThreadId(),
              getCurrentChatThreadId: () => chat.getThreadId(),
            });
          }
          return;
        }
        // A late failure for a replaced request still cleans that exact context,
        // but should not warn for or disturb the newer owned request.
        if (!failure.abandonedOwnedRequest) {
          return;
        }
        services.notifications.toasts.addWarning(
          i18n.translate('data.pplLint.aiFix.openChatError', {
            defaultMessage: 'Could not open AI for this PPL lint fix.',
          })
        );
      });
  }

  function getLintContext(): PPLLintContext {
    const aiFixToolName = (services as IDataPluginServices & PPLLintFixServiceCapability)
      .pplLintFixToolName;
    const chatAvailable = Boolean(
      aiFixToolName &&
        services.chat?.sendMessageWithWindow &&
        (services.chat.isAvailable?.() ?? true)
    );
    return buildPPLLintContext(
      queryRef.current.dataset,
      lintFieldsRef.current,
      services,
      chatAvailable ? { onAskAiFix, aiFixToolName } : undefined
    );
  }

  useEffect(
    () => () => {
      pplLintFixLifecycle.dispose();
      cleanupPPLContexts(detachRefs.current);
    },
    [pplLintFixLifecycle]
  );

  useEffect(() => {
    const subscription = services.application?.currentAppId$?.subscribe?.((appId) => {
      setCurrentAppId(appId || '');
    });
    return () => subscription?.unsubscribe();
  }, [services.application?.currentAppId$]);

  useEffect(() => {
    const dsId = query.dataset?.dataSource?.id;
    const dsVersion = query.dataset?.dataSource?.version;
    syncPPLValidationContext(inputRef.current, {
      useRuntimeGrammar: shouldUseRuntimeGrammar(dsId, dsVersion),
      dataSourceId: dsId,
      dataSourceVersion: dsVersion,
    });

    const model = inputRef.current?.getModel();
    if (model) {
      void revalidatePPLModel(model);
    }
  }, [query.dataset?.dataSource?.id, query.dataset?.dataSource?.version]);

  // Load field metadata for the active dataset and feed it to the lint context.
  // Field-aware lint rules self-suppress until this resolves, so we set the
  // context in a single phase after the async load to avoid flicker (R8.5).
  useEffect(() => {
    const datasetId = query.dataset?.id;
    const dsId = query.dataset?.dataSource?.id;
    let cancelled = false;

    const syncLint = () => {
      // Single context constructor: buildPPLLintContext (via getLintContext) is
      // the only place a PPLLintContext is assembled, so datasetTitle /
      // enableAIFeatures cannot be dropped here (they were absent from the old
      // hand-rolled inline object, which left the AI quick-fix lightbulb hidden
      // after every dataset load). It reads the same refs (lintFieldsRef /
      // queryRef) that loadFields updates synchronously before this call, and
      // applies the cacheMatchesDataset guard the inline object lacked.
      syncPPLLintContext(inputRef.current, getLintContext());
      const model = inputRef.current?.getModel();
      if (model) {
        void revalidatePPLModel(model);
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
        const indexPattern = await getIndexPatterns().get(datasetId);
        if (cancelled) {
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

        // The `enabled: false` object attribute is stripped by `_field_caps`
        // (and so absent from `indexPattern.fields`); fetch it separately from
        // the read-only mappings route. Best-effort: on any failure the set is
        // left undefined and the `enabled-false-object` rule self-suppresses.
        // The visible-index list (for wildcard-source-zero-match) is fetched
        // concurrently so the two loads stay in step — both gate the same
        // single-phase context update below.
        // Probe per-source AI reachability only when chat is wired at all —
        // otherwise the AI button is already hidden by the missing opener, so the
        // probe would be a wasted call on every dataset switch. Fail-open when
        // unprobed (undefined leaves the action shown).
        const shouldProbeAi = Boolean(services.http && (services.chat?.isAvailable?.() ?? false));
        const [
          disabledObjectFields,
          visibleIndices,
          aiAgentAvailableForSource,
        ] = await Promise.all([
          services.http
            ? fetchDisabledObjectFields(services.http, indexPattern)
            : Promise.resolve(undefined),
          services.http ? fetchVisibleIndices(services.http, dsId) : Promise.resolve([]),
          shouldProbeAi
            ? getAiAgentAvailableForDataSource(services.http!, dsId, 5000)
            : Promise.resolve(undefined),
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
          aiAgentAvailableForSource,
        };
        // Single-phase update after the async load resolves (R8.5).
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
    // syncLint now calls the component-scope getLintContext(); it reads only the
    // refs/services already covered by the deps below, so it is intentionally
    // omitted (same pattern as the settings-change effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    query.dataset?.id,
    query.dataset?.dataSource?.id,
    query.dataset?.dataSource?.version,
    services.http,
    services.uiSettings,
  ]);

  // Live-revalidate when a per-rule lint setting changes — no page reload. Both
  // lint paths read the per-model context, so refresh it from getLintContext
  // (which rebuilds overrides) before revalidating, otherwise the stored
  // context would still carry the pre-change overrides.
  //
  // We subscribe to getUpdate$ (the optimistic local write) so squiggles
  // refresh the moment the JSON setting is saved in Advanced Settings, without
  // waiting for the next keystroke. The setting is a single global key, so the
  // optimistic value is the resolved value.
  useEffect(() => {
    const subscription = services.uiSettings.getUpdate$().subscribe(({ key }) => {
      if (key !== UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULES) {
        return;
      }
      syncPPLLintContext(inputRef.current, getLintContext());
      const model = inputRef.current?.getModel();
      if (model) {
        void revalidatePPLModel(model);
      }
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services.uiSettings]);

  const renderQueryEditorExtensions = () => {
    if (
      !(
        headerRef.current &&
        bannerRef.current &&
        queryControlsContainer.current &&
        bottomPanelRef.current &&
        query.language &&
        extensionMap &&
        Object.keys(extensionMap).length > 0
      )
    ) {
      return null;
    }
    return (
      <QueryEditorExtensions
        language={query.language}
        onSelectLanguage={onSelectLanguage}
        isCollapsed={isCollapsed}
        setIsCollapsed={setIsCollapsed}
        configMap={extensionMap}
        componentContainer={headerRef.current}
        bannerContainer={bannerRef.current}
        queryControlsContainer={queryControlsContainer.current}
        bottomPanelContainer={bottomPanelRef.current}
        query={query}
        fetchStatus={props.queryStatus?.status}
      />
    );
  };

  const onSubmit = (currentQuery: Query, dateRange?: TimeRange) => {
    if (props.onSubmit) {
      if (persistedLogRef.current) {
        persistedLogRef.current.add(currentQuery.query);
      }

      // Add query to queryString history for Recent Queries feature
      if (currentQuery.query?.trim()) {
        queryString.addToQueryHistory(currentQuery, dateRange);
      }

      props.onSubmit(
        {
          ...currentQuery,
          query: fromUser(currentQuery.query),
        },
        dateRange
      );
    }
  };

  const onChange = (currentQuery: Query, dateRange?: TimeRange) => {
    if (props.onChange) {
      props.onChange(
        {
          ...currentQuery,
          query: fromUser(currentQuery.query),
        },
        dateRange
      );
    }
  };

  const onQueryStringChange = (value: string) => {
    onChange({
      query: value,
      language: query.language,
      dataset: query.dataset,
    });
  };

  const onClickRecentQuery = (currentQuery: Query, timeRange?: TimeRange) => {
    onSubmit(currentQuery, timeRange);
  };

  const onInputChange = (value: string) => {
    onQueryStringChange(value);

    if (!inputRef.current) return;

    const currentLineCount = inputRef.current.getModel()?.getLineCount();
    if (lineCount === currentLineCount) return;
    setLineCount(currentLineCount);
  };

  const onSelectLanguage = (languageId: string) => {
    const newQuery = queryString.getInitialQueryByLanguage(languageId);

    onChange(newQuery);
    onSubmit(newQuery);
  };

  const toggleRecentQueries = () => {
    setIsRecentQueryVisible(!isRecentQueryVisible);
  };

  const renderToggleIcon = () => {
    return (
      <EuiFlexItem grow={false}>
        <EuiButtonIcon
          iconType={isCollapsed ? 'expand' : 'minimize'}
          aria-label={i18n.translate('data.queryControls.languageToggle', {
            defaultMessage: `Language Toggle`,
          })}
          onClick={() => setIsCollapsed(!isCollapsed)}
          data-test-subj="osdQueryEditorLanguageToggle"
        />
      </EuiFlexItem>
    );
  };

  const renderQueryControls = (queryControls: React.ReactElement[]) => {
    return <QueryControls queryControls={queryControls} />;
  };

  const provideCompletionItems = async (
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.CompletionContext,
    token: monaco.CancellationToken
  ): Promise<monaco.languages.CompletionList> => {
    if (token.isCancellationRequested) {
      return { suggestions: [], incomplete: false };
    }

    const dataset = queryString.getQuery().dataset;
    let indexPattern;
    if (dataset) {
      try {
        indexPattern = await getIndexPatterns().get(dataset.id);
      } catch {
        // INDEXES datasets use a cached temporary index pattern that may not
        // exist as a saved object. Gracefully degrade — keyword suggestions
        // still work without an index pattern.
      }
    }

    const language = getEffectiveLanguageForAutoComplete(queryRef.current.language, currentAppId);

    const suggestions = await services.data.autocomplete.getQuerySuggestions({
      query: inputRef.current?.getValue() ?? '',
      selectionStart: model.getOffsetAt(position), // not needed, position handles same thing. remove
      selectionEnd: model.getOffsetAt(position),
      language,
      indexPattern,
      datasetType: dataset?.type,
      position,
      services,
    });

    // current completion item range being given as last 'word' at pos
    const wordUntil = model.getWordUntilPosition(position);
    const defaultRange = new monaco.Range(
      position.lineNumber,
      wordUntil.startColumn,
      position.lineNumber,
      wordUntil.endColumn
    );

    return {
      suggestions:
        suggestions && suggestions.length > 0
          ? (suggestions.filter((s) => 'detail' in s) as MonacoCompatibleQuerySuggestion[]) // Cast the filtered array
              .map(
                (
                  s: MonacoCompatibleQuerySuggestion,
                  _index: number,
                  _array: MonacoCompatibleQuerySuggestion[]
                ) => {
                  return {
                    label: s.text,
                    kind: s.type as monaco.languages.CompletionItemKind,
                    insertText: s.insertText ?? s.text,
                    insertTextRules: s.insertTextRules ?? undefined,
                    range: s.replacePosition ?? defaultRange,
                    detail: s.detail,
                    command: {
                      id: 'editor.action.triggerSuggest',
                      title: 'Trigger Next Suggestion',
                    },
                    sortText: s.sortText ?? s.text, // when undefined, the falsy value will default to the label
                  };
                }
              )
          : [],
      incomplete: false,
    };
  };

  const useQueryEditor = query.language !== 'kuery' && query.language !== 'lucene';

  const languageSelector = (
    <QueryLanguageSelector
      anchorPosition={props.languageSwitcherPopoverAnchorPosition}
      onSelectLanguage={onSelectLanguage}
      appName={services.appName}
    />
  );

  const baseInputProps = {
    languageId: query.language,
    value: toUser(editorQuery.query),
  };

  const defaultInputProps: DefaultInputProps = {
    ...baseInputProps,
    onChange: onInputChange,
    editorDidMount: (editor: monaco.editor.IStandaloneCodeEditor) => {
      setLineCount(editor.getModel()?.getLineCount());
      inputRef.current = editor;
      attachPPLContexts(
        editor,
        detachRefs.current,
        getValidationContext,
        getLintContext,
        (listener) => pplGrammarCache.subscribeToGrammarUpdates(listener),
        revalidatePPLModel
      );
      const editorModel = editor.getModel();
      if (editorModel) {
        void revalidatePPLModel(editorModel);
      }
      // eslint-disable-next-line no-bitwise
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        const newQuery = {
          ...queryRef.current,
          query: editor.getValue(),
        };

        onSubmit(newQuery, timefilter.getTime());
      });

      return () => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
      };
    },
    footerItems: {
      start: [
        <EuiText
          size="xs"
          color="subdued"
          className="queryEditor__footerItem"
          data-test-subj="queryEditorFooterLineCount"
        >
          {`${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}
        </EuiText>,
        <EuiText
          size="xs"
          color="subdued"
          data-test-subj="queryEditorFooterTimestamp"
          className="queryEditor__footerItem"
        >
          {query.dataset?.timeFieldName || ''}
        </EuiText>,
        <QueryResult queryStatus={props.queryStatus!} />,
      ],
      end: [
        <EuiButtonEmpty
          iconSide="left"
          iconType="clock"
          size="xs"
          onClick={toggleRecentQueries}
          className="queryEditor__footerItem"
          data-test-subj="queryEditorFooterToggleRecentQueriesButton"
        >
          <EuiText size="xs" color="subdued">
            {'Recent queries'}
          </EuiText>
        </EuiButtonEmpty>,
      ],
    },
    provideCompletionItems,
    queryStatus: props.queryStatus,
  };

  const singleLineInputProps = {
    ...baseInputProps,
    onChange: (value: string) => {
      // Replace new lines with an empty string to prevent multi-line input
      onQueryStringChange(value.replace(/[\r\n]+/gm, ''));
      setLineCount(undefined);
    },
    editorDidMount: (editor: monaco.editor.IStandaloneCodeEditor) => {
      inputRef.current = editor;
      attachPPLContexts(
        editor,
        detachRefs.current,
        getValidationContext,
        getLintContext,
        (listener) => pplGrammarCache.subscribeToGrammarUpdates(listener),
        revalidatePPLModel
      );
      const singleLineModel = editor.getModel();
      if (singleLineModel) {
        void revalidatePPLModel(singleLineModel);
      }

      editor.addCommand(monaco.KeyCode.Enter, () => {
        const newQuery = {
          ...queryRef.current,
          query: editor.getValue(),
        };

        onSubmit(newQuery, timefilter.getTime());
      });
    },
    provideCompletionItems,
    prepend: props.prepend,
    footerItems: {
      start: [
        <EuiText
          size="xs"
          color="subdued"
          className="queryEditor__footerItem"
          data-test-subj="queryEditorFooterLineCount"
        >
          {`${lineCount ?? 1} ${lineCount === 1 || !lineCount ? 'line' : 'lines'}`}
        </EuiText>,
        <EuiText
          size="xs"
          color="subdued"
          className="queryEditor__footerItem"
          data-test-subj="queryEditorFooterTimestamp"
        >
          {query.dataset?.timeFieldName || ''}
        </EuiText>,
        <QueryResult queryStatus={props.queryStatus!} />,
      ],
      end: [
        <EuiButtonEmpty
          iconSide="left"
          iconType="clock"
          iconGap="s"
          size="xs"
          onClick={toggleRecentQueries}
          className="queryEditor__footerItem"
          data-test-subj="queryEditorFooterToggleRecentQueriesButton"
          flush="both"
        >
          <EuiText size="xs" color="subdued">
            {'Recent queries'}
          </EuiText>
        </EuiButtonEmpty>,
      ],
    },
    queryStatus: props.queryStatus,
  };

  const languageEditorFunc = languageManager.getLanguage(query.language)!.editor;

  const languageEditor = useQueryEditor
    ? languageEditorFunc(singleLineInputProps, {}, defaultInputProps)
    : languageEditorFunc(singleLineInputProps, singleLineInputProps, {
        filterBar: props.filterBar,
      });

  return (
    <div
      className={classNames(
        props.className,
        'osdQueryEditor',
        isCollapsed ? 'collapsed' : 'expanded',
        !languageEditor.TopBar.Expanded && 'emptyExpanded'
      )}
    >
      <div
        ref={bannerRef}
        className={classNames('osdQueryEditor__banner', props.bannerClassName)}
      />
      <div className="osdQueryEditor__topBar" data-test-subj="osdQueryEditorTopBar">
        <div className="osdQueryEditor__input" data-test-subj="osdQueryEditorInput">
          {isCollapsed
            ? languageEditor.TopBar.Collapsed()
            : languageEditor.TopBar.Expanded && languageEditor.TopBar.Expanded()}
        </div>
        {languageSelector}
        <div className="osdQueryEditor__querycontrols" data-test-subj="osdQueryEditorQueryControls">
          <EuiFlexGroup responsive={false} gutterSize="s" alignItems="center">
            <div
              ref={queryControlsContainer}
              className="osdQueryEditor__extensionQueryControls"
              data-test-subj="osdQueryEditorExtensionQueryControls"
            />
            {renderQueryControls(languageEditor.TopBar.Controls)}
            {!languageEditor.TopBar.Expanded && renderToggleIcon()}
            {props.savedQueryManagement}
          </EuiFlexGroup>
        </div>
      </div>
      <div
        ref={headerRef}
        className={classNames('osdQueryEditor__header', props.headerClassName)}
      />
      {!isCollapsed && (
        <>
          <div className="osdQueryEditor__body">{languageEditor.Body()}</div>
        </>
      )}
      <RecentQueriesTable
        isVisible={isRecentQueryVisible}
        queryString={queryString}
        onClickRecentQuery={onClickRecentQuery}
      />
      <div ref={bottomPanelRef} />
      {renderQueryEditorExtensions()}
    </div>
  );
};

// eslint-disable-next-line import/no-default-export
export default QueryEditorUI;
