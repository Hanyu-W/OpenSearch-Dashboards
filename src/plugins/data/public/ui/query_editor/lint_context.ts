/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { clearPPLLintContext, monaco, PPLLintContext, setPPLLintContext } from '@osd/monaco';

function applyLintContext(
  model: monaco.editor.ITextModel | null | undefined,
  context: PPLLintContext
): void {
  if (!model) {
    return;
  }
  setPPLLintContext(model, context);
}

export function syncPPLLintContext(
  editor: monaco.editor.IStandaloneCodeEditor | null | undefined,
  context: PPLLintContext
): void {
  applyLintContext(editor?.getModel(), context);
}

export function attachPPLLintContext(
  editor: monaco.editor.IStandaloneCodeEditor,
  getContext: () => PPLLintContext
): () => void {
  let currentModel = editor.getModel();
  applyLintContext(currentModel, getContext());

  const modelChangeSubscription = editor.onDidChangeModel(() => {
    if (currentModel) {
      clearPPLLintContext(currentModel);
    }

    currentModel = editor.getModel();
    applyLintContext(currentModel, getContext());
  });

  return () => {
    if (currentModel) {
      clearPPLLintContext(currentModel);
    }
    modelChangeSubscription.dispose();
  };
}

export function attachPPLLintGrammarRefresh(
  editor: monaco.editor.IStandaloneCodeEditor,
  getContext: () => PPLLintContext,
  subscribeToGrammarUpdates: (
    listener: (event: { dataSourceId?: string; grammarHash: string }) => void
  ) => () => void,
  revalidateModel: (model: monaco.editor.ITextModel) => Promise<void> | void
): () => void {
  return subscribeToGrammarUpdates((event) => {
    const model = editor.getModel();
    const context = getContext();

    if (!model || !context.useRuntimeGrammar) {
      return;
    }

    if ((context.dataSourceId ?? undefined) !== event.dataSourceId) {
      return;
    }

    setPPLLintContext(model, context);
    void revalidateModel(model);
  });
}
