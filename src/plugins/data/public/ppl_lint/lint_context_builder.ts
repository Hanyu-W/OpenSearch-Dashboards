/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { i18n } from '@osd/i18n';
import { IUiSettingsClient } from 'opensearch-dashboards/public';
import { PPLLintContext } from '@osd/monaco';
import { ENABLE_AI_FEATURES, HttpSetup, NotificationsStart } from '../../../../core/public';
import {
  deriveIsCalcite,
  shouldUseRuntimeGrammar,
} from '../antlr/opensearch_ppl/ppl_grammar_cache';
import { calciteSettingsCache } from './calcite_settings';
import { buildOverridesFromSettings } from './lint_overrides';

/**
 * Per-dataset field metadata cache for PPL lint. Both editor hosts — the data
 * plugin's `query_editor.tsx` and explore's `use_query_panel_editor.ts` — hold
 * one ref of this shape, populated asynchronously after a dataset change.
 * Field-aware lint rules self-suppress until it resolves.
 */
export interface LintFieldsCache {
  datasetId?: string;
  fields?: Set<string>;
  typeMap?: Map<string, string>;
  disabledObjectFields?: Set<string>;
  visibleIndices?: string[];
}

/** The dataset fields the lint context derives from; structural so either host's
 * dataset shape (a `Dataset` or a `Query['dataset']`) satisfies it. */
interface LintContextDataset {
  id?: string;
  /** Human-readable dataset name; the index the AI quick-fix generate route needs. */
  title?: string;
  dataSource?: { id?: string; version?: string };
}

type PPLLintAiFixHooks = Pick<PPLLintContext, 'onAskAiFix' | 'aiFixToolName'>;

/**
 * Assemble the per-model {@link PPLLintContext} from the active dataset, the
 * asynchronously-loaded field cache, and the host services. Shared by both
 * editor hosts so the context they feed the lint engine never drifts.
 *
 * Cached field metadata is only fed to the rules when it belongs to the dataset
 * the query currently targets: after a dataset switch the async field load for
 * the new dataset has not resolved yet, so the cache still holds the previous
 * dataset's fields — using them would make field-aware rules fire against the
 * wrong index. When they don't match, the fields are omitted so those rules
 * self-suppress until the new load resolves.
 */
export function buildPPLLintContext(
  dataset: LintContextDataset | undefined,
  lintFields: LintFieldsCache,
  services: {
    uiSettings: IUiSettingsClient;
    http: HttpSetup;
    notifications: NotificationsStart;
  },
  aiFix?: PPLLintAiFixHooks
): PPLLintContext {
  const dsId = dataset?.dataSource?.id;
  const dsVersion = dataset?.dataSource?.version;
  const cacheMatchesDataset = lintFields.datasetId === dataset?.id;
  const calcite = calciteSettingsCache.getCached(dsId);
  const context: PPLLintContext = {
    useRuntimeGrammar: shouldUseRuntimeGrammar(dsId, dsVersion),
    dataSourceId: dsId,
    dataSourceVersion: dsVersion,
    isCalcite: calcite?.isCalcite ?? deriveIsCalcite(dsVersion),
    settings: { allJoinTypesAllowed: calcite?.allJoinTypesAllowed ?? false },
    fields: cacheMatchesDataset ? lintFields.fields : undefined,
    typeMap: cacheMatchesDataset ? lintFields.typeMap : undefined,
    disabledObjectFields: cacheMatchesDataset ? lintFields.disabledObjectFields : undefined,
    visibleIndices: cacheMatchesDataset ? lintFields.visibleIndices : undefined,
    overrides: buildOverridesFromSettings(services.uiSettings),
    http: services.http,
    // Dataset metadata + AI-feature/chat hooks the "Ask AI to fix" command
    // reads via getPPLLintContext(model). enableAIFeatures hides the action
    // entirely when AI features are off. These ride the runtime bridge path only.
    datasetTitle: dataset?.title,
    enableAIFeatures: Boolean(services.uiSettings.get(ENABLE_AI_FEATURES, true)),
    onAskAiFix: aiFix?.onAskAiFix,
    aiFixToolName: aiFix?.aiFixToolName,
    // Host-owned feedback for the AI fix round-trip. The leaf package can't raise
    // a toast, so it calls back here. ai-disabled / no-index are expected silent
    // states (the action wouldn't have shown), so they raise nothing.
    onAiFixOutcome: (outcome) => {
      const toasts = services.notifications.toasts;
      if (outcome.status === 'applied') {
        toasts.addSuccess(
          i18n.translate('data.pplLint.aiFix.applied', {
            defaultMessage: 'Applied the AI-suggested fix.',
          })
        );
      } else if (outcome.status === 'error') {
        toasts.addWarning(
          i18n.translate('data.pplLint.aiFix.error', {
            defaultMessage: 'Could not reach the AI fix service.',
          })
        );
      } else if (outcome.status === 'rejected') {
        toasts.addWarning(
          i18n.translate('data.pplLint.aiFix.rejected', {
            defaultMessage: 'The AI could not produce a safe fix for this query.',
          })
        );
      } else if (outcome.reason === 'no-agent') {
        toasts.addWarning(
          i18n.translate('data.pplLint.aiFix.noAgent', {
            defaultMessage: 'No AI assistant is configured for this data source.',
          })
        );
      }
    },
  };
  return context;
}
