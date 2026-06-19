/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { IUiSettingsClient } from 'opensearch-dashboards/public';
import { PPLLintContext } from '@osd/monaco';
import { HttpSetup } from '../../../../core/public';
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
  dataSource?: { id?: string; version?: string };
}

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
  services: { uiSettings: IUiSettingsClient; http: HttpSetup }
): PPLLintContext {
  const dsId = dataset?.dataSource?.id;
  const dsVersion = dataset?.dataSource?.version;
  const cacheMatchesDataset = lintFields.datasetId === dataset?.id;
  const calcite = calciteSettingsCache.getCached(dsId);
  return {
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
  };
}
