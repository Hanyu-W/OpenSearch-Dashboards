/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { LintPayloadContext, LintRunContext, WorkerLintContextPayload } from './types';

type WorkerLintContextSource = LintPayloadContext & {
  dataSourceId?: string;
  dataSourceVersion?: string;
};

export function toWorkerLintContextPayload(
  context: WorkerLintContextSource | undefined
): WorkerLintContextPayload | undefined {
  if (!context) {
    return undefined;
  }

  const payload: WorkerLintContextPayload = {
    isCalcite: context.isCalcite,
    dataSourceEngineType: context.dataSourceEngineType,
    dataSourceId: context.dataSourceId,
    dataSourceVersion: context.dataSourceVersion,
    fields: context.fields ? Array.from(context.fields) : undefined,
    typeMap: context.typeMap ? Array.from(context.typeMap.entries()) : undefined,
    disabledObjectFields: context.disabledObjectFields
      ? Array.from(context.disabledObjectFields)
      : undefined,
    visibleIndices: context.visibleIndices ? [...context.visibleIndices] : undefined,
    settings: context.settings ? { ...context.settings } : undefined,
    overrides: context.overrides,
  };

  return Object.values(payload).some((value) => value !== undefined) ? payload : undefined;
}

export function hydrateWorkerLintContext(
  payload: WorkerLintContextPayload | undefined
): LintRunContext | undefined {
  if (!payload) {
    return undefined;
  }

  return {
    isCalcite: payload.isCalcite,
    dataSourceEngineType: payload.dataSourceEngineType,
    dataSourceId: payload.dataSourceId,
    dataSourceVersion: payload.dataSourceVersion,
    fields: payload.fields ? new Set(payload.fields) : undefined,
    typeMap: payload.typeMap ? new Map(payload.typeMap) : undefined,
    disabledObjectFields: payload.disabledObjectFields
      ? new Set(payload.disabledObjectFields)
      : undefined,
    visibleIndices: payload.visibleIndices ? [...payload.visibleIndices] : undefined,
    settings: payload.settings ? { ...payload.settings } : undefined,
    overrides: payload.overrides,
  };
}
