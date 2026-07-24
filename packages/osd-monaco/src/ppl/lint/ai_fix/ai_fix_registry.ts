/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import type { DiagnosticAiFix } from '../diagnostic';

interface AiFixRegistryState {
  byModel: WeakMap<monaco.editor.ITextModel, Map<string, DiagnosticAiFix>>;
}

const AI_FIX_REGISTRY_KEY = '__osdPPLLintAiFixRegistry';

function getState(): AiFixRegistryState {
  const globalScope = globalThis as typeof globalThis & {
    [AI_FIX_REGISTRY_KEY]?: AiFixRegistryState;
  };
  if (!globalScope[AI_FIX_REGISTRY_KEY]) {
    globalScope[AI_FIX_REGISTRY_KEY] = { byModel: new WeakMap() };
  }
  return globalScope[AI_FIX_REGISTRY_KEY]!;
}

export function setModelAiFixMetadata(
  model: monaco.editor.ITextModel,
  metadata: Map<string, DiagnosticAiFix>
): void {
  if (metadata.size === 0) {
    getState().byModel.delete(model);
    return;
  }
  getState().byModel.set(model, metadata);
}

export function getModelAiFixMetadata(
  model: monaco.editor.ITextModel,
  key: string
): DiagnosticAiFix | undefined {
  return getState().byModel.get(model)?.get(key);
}

export function clearModelAiFixMetadata(model: monaco.editor.ITextModel): void {
  getState().byModel.delete(model);
}
