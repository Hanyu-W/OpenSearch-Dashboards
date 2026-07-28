/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpSetup } from '../../../../core/public';
import { getAiAgentAvailableForDataSource } from './ai_agent_availability';
import { calciteSettingsCache } from './calcite_settings';
import { fetchDisabledObjectFields } from './disabled_object_fields';
import { LintFieldsCache } from './lint_context_builder';
import { fetchVisibleIndices } from './visible_indices';

interface PPLLintCapabilities {
  queryEnhancements?: {
    pplLint?: unknown;
  };
}

interface PPLLintIndexPattern {
  title?: string;
  dataSourceRef?: { id?: string };
  fields?: Array<{ name?: string; esTypes?: string[] } | undefined>;
}

interface LoadPPLLintFieldsOptions {
  enabled: boolean;
  datasetId?: string;
  dataSourceId?: string;
  getIndexPattern: (datasetId: string) => Promise<PPLLintIndexPattern | undefined>;
  http?: HttpSetup;
  probeAiAgent: boolean;
}

export function isPPLLintEnabled(capabilities?: unknown): boolean {
  const candidate = capabilities as PPLLintCapabilities | undefined;
  return candidate?.queryEnhancements?.pplLint === true;
}

/**
 * Load all metadata consumed only by PPL lint. The capability check is inside
 * this request boundary so a disabled deployment cannot start an index-pattern,
 * mapping, visible-index, or AI-agent request from either editor host.
 */
export async function loadPPLLintFields({
  enabled,
  datasetId,
  dataSourceId,
  getIndexPattern,
  http,
  probeAiAgent,
}: LoadPPLLintFieldsOptions): Promise<LintFieldsCache> {
  if (!enabled || !datasetId) {
    return {};
  }

  const indexPattern = await getIndexPattern(datasetId);
  if (!indexPattern) {
    return {};
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

  const [disabledObjectFields, visibleIndices, aiAgentAvailableForSource] = await Promise.all([
    http ? fetchDisabledObjectFields(http, indexPattern) : Promise.resolve(undefined),
    http ? fetchVisibleIndices(http, dataSourceId) : Promise.resolve([]),
    http && probeAiAgent
      ? getAiAgentAvailableForDataSource(http, dataSourceId, 5000)
      : Promise.resolve(undefined),
  ]);

  return {
    datasetId,
    fields,
    typeMap,
    disabledObjectFields,
    visibleIndices,
    aiAgentAvailableForSource,
  };
}

/** Resolve lint-only Calcite settings without issuing a request when disabled. */
export function resolvePPLLintSettings(
  enabled: boolean,
  http: HttpSetup | undefined,
  dataSourceId?: string
): Promise<void> | undefined {
  if (!enabled || !http) {
    return undefined;
  }
  return calciteSettingsCache.resolve(http, dataSourceId).then(() => undefined);
}
