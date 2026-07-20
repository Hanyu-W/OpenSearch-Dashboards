/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const mockSetPPLLintEnabled = jest.fn();
const mockUnregisterBridge = jest.fn();
const mockRegisterPPLLintBridge = jest.fn(() => mockUnregisterBridge);
const mockUnregisterTelemetry = jest.fn();
const mockRegisterPPLLintTelemetry = jest.fn(() => mockUnregisterTelemetry);
const mockLintRuntimePPLQuery = jest.fn();

jest.mock('@osd/monaco', () => ({
  setPPLLintEnabled: (enabled: boolean) => mockSetPPLLintEnabled(enabled),
  registerPPLLintBridge: (bridge: unknown) => mockRegisterPPLLintBridge(bridge),
  registerPPLLintTelemetry: (sink: unknown) => mockRegisterPPLLintTelemetry(sink),
}));

jest.mock('../../../data/public', () => ({
  lintRuntimePPLQuery: (...args: unknown[]) => mockLintRuntimePPLQuery(...args),
}));

import { registerPplLint } from './register_ppl_lint';

describe('registerPplLint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('disables the engine and registers nothing when the capability is off', () => {
    const sink = jest.fn();
    const disposer = registerPplLint(false, sink);

    expect(mockSetPPLLintEnabled).toHaveBeenCalledWith(false);
    expect(mockRegisterPPLLintBridge).not.toHaveBeenCalled();
    expect(mockRegisterPPLLintTelemetry).not.toHaveBeenCalled();
    expect(disposer).toBeUndefined();
  });

  it('enables the engine, registers the lint bridge, and wires telemetry when a sink is given', () => {
    const sink = jest.fn();
    const disposer = registerPplLint(true, sink);

    expect(mockSetPPLLintEnabled).toHaveBeenCalledWith(true);
    expect(mockRegisterPPLLintBridge).toHaveBeenCalledTimes(1);
    // The runtime lint function from the data plugin is passed as the bridge.
    expect(mockRegisterPPLLintBridge).toHaveBeenCalledWith(expect.any(Function));
    expect(mockRegisterPPLLintTelemetry).toHaveBeenCalledWith(sink);
    expect(disposer).toEqual(expect.any(Function));
  });

  it('registers the bridge but no telemetry when enabled with no sink', () => {
    const disposer = registerPplLint(true);

    expect(mockSetPPLLintEnabled).toHaveBeenCalledWith(true);
    expect(mockRegisterPPLLintTelemetry).not.toHaveBeenCalled();
    // Still returns a disposer for the bridge.
    expect(mockRegisterPPLLintBridge).toHaveBeenCalledTimes(1);
    expect(disposer).toEqual(expect.any(Function));
  });

  it('returns a disposer that unregisters both the bridge and telemetry', () => {
    const sink = jest.fn();
    const disposer = registerPplLint(true, sink);
    disposer?.();
    expect(mockUnregisterBridge).toHaveBeenCalledTimes(1);
    expect(mockUnregisterTelemetry).toHaveBeenCalledTimes(1);
  });

  it('returns a disposer that unregisters just the bridge when no sink is wired', () => {
    const disposer = registerPplLint(true);
    disposer?.();
    expect(mockUnregisterBridge).toHaveBeenCalledTimes(1);
    expect(mockUnregisterTelemetry).not.toHaveBeenCalled();
  });
});
