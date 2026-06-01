/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';
import { diagnosticToMarker } from './diagnostic_to_marker';
import type { Diagnostic } from './diagnostic';

// M1 — validates Property 3 (Column invariant) and Requirements 5.1-5.5, 1.3-1.5.

const baseDiagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
  ruleId: 'rex-no-underscore',
  severity: 'warning',
  message: 'capture group names cannot contain underscores',
  range: { startLine: 1, startColumn: 10, endLine: 1, endColumn: 20 },
  ...overrides,
});

describe('diagnosticToMarker', () => {
  it('converts ANTLR 0-based columns to Monaco 1-based by adding 1', () => {
    const marker = diagnosticToMarker(
      baseDiagnostic({ range: { startLine: 1, startColumn: 10, endLine: 1, endColumn: 20 } })
    );

    expect(marker.startColumn).toBe(11);
    expect(marker.endColumn).toBe(21);
  });

  it('clamps startColumn to at least 1', () => {
    const marker = diagnosticToMarker(
      baseDiagnostic({ range: { startLine: 1, startColumn: -5, endLine: 1, endColumn: 0 } })
    );

    expect(marker.startColumn).toBeGreaterThanOrEqual(1);
  });

  it('clamps endColumn to be at least startColumn', () => {
    const marker = diagnosticToMarker(
      baseDiagnostic({ range: { startLine: 1, startColumn: 30, endLine: 1, endColumn: 5 } })
    );

    expect(marker.endColumn).toBeGreaterThanOrEqual(marker.startColumn);
  });

  it('clamps startLineNumber to at least 1', () => {
    const marker = diagnosticToMarker(
      baseDiagnostic({ range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 1 } })
    );

    expect(marker.startLineNumber).toBeGreaterThanOrEqual(1);
  });

  it('clamps endLineNumber to be at least startLineNumber', () => {
    const marker = diagnosticToMarker(
      baseDiagnostic({ range: { startLine: 5, startColumn: 0, endLine: 2, endColumn: 1 } })
    );

    expect(marker.endLineNumber).toBeGreaterThanOrEqual(marker.startLineNumber);
  });

  it('maps the warning severity to monaco Warning (yellow squiggly)', () => {
    const marker = diagnosticToMarker(baseDiagnostic({ severity: 'warning' }));

    expect(marker.severity).toBe(monaco.MarkerSeverity.Warning);
  });

  it('maps error and info severities to their monaco equivalents', () => {
    expect(diagnosticToMarker(baseDiagnostic({ severity: 'error' })).severity).toBe(
      monaco.MarkerSeverity.Error
    );
    expect(diagnosticToMarker(baseDiagnostic({ severity: 'info' })).severity).toBe(
      monaco.MarkerSeverity.Info
    );
  });

  it('attaches the message and ppl-lint source', () => {
    const marker = diagnosticToMarker(baseDiagnostic({ message: 'hello' }));

    expect(marker.message).toBe('hello');
    expect(marker.source).toBe('ppl-lint');
  });

  it('sets code to a value+target object when docUrl is present', () => {
    const docUrl = 'https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/rex/';
    const marker = diagnosticToMarker(baseDiagnostic({ docUrl }));

    expect(typeof marker.code).toBe('object');
    const code = marker.code as { value: string; target: monaco.Uri };
    expect(code.value).toBe('rex-no-underscore');
    expect(code.target).toEqual(monaco.Uri.parse(docUrl));
  });

  it('sets code to the bare ruleId string when docUrl is absent', () => {
    const marker = diagnosticToMarker(baseDiagnostic({ docUrl: undefined }));

    expect(marker.code).toBe('rex-no-underscore');
  });
});
