/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { buildPipelineShape } from '../pipeline_shape';
import { rangeFromContext } from '../range_utils';

// Advisory (no engine throw): a `head` with no preceding `sort` in the pipeline
// returns nondeterministic rows.

export const headWithoutSortDetector: Detector = (tree, config, _context, ruleNameToIndex) => {
  const diagnostics: Diagnostic[] = [];
  const { stages } = buildPipelineShape(tree, ruleNameToIndex);

  let sawSort = false;
  for (const stage of stages) {
    if (stage.command === 'sortCommand') {
      sawSort = true;
      continue;
    }
    if (stage.command === 'headCommand') {
      if (!sawSort) {
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: 'head without a preceding sort returns nondeterministic rows.',
          range: rangeFromContext(stage.node),
          docUrl: config.docUrl,
        });
      }
    }
  }

  return diagnostics;
};
