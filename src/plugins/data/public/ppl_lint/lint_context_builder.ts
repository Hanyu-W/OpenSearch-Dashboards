/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { IUiSettingsClient } from 'opensearch-dashboards/public';
import { PPLLintContext } from '@osd/monaco';
import { ENABLE_AI_FEATURES, HttpSetup } from '../../../../core/public';
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
  /**
   * Whether the AI lint-fix agent is reachable for this dataset's data source,
   * resolved asynchronously alongside the field metadata. Undefined until the
   * probe resolves, which leaves the AI quick-fix shown (fail-open).
   */
  aiAgentAvailableForSource?: boolean;
}

/** The dataset fields the lint context derives from; structural so either host's
 * dataset shape (a `Dataset` or a `Query['dataset']`) satisfies it. */
interface LintContextDataset {
  id?: string;
  /** Human-readable dataset name included in chat-based lint-fix requests. */
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
    // Per-source AI reachability rides the same cacheMatchesDataset guard as the
    // field metadata: after a dataset switch the previous source's answer must
    // not gate the new source, so it is dropped until the new probe resolves
    // (undefined → shown, matching the fail-open contract).
    aiAgentAvailableForSource: cacheMatchesDataset
      ? lintFields.aiAgentAvailableForSource
      : undefined,
    onAskAiFix: aiFix?.onAskAiFix,
    aiFixToolName: aiFix?.aiFixToolName,
  };
  return context;
}
