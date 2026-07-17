/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const mockSetPPLLintEnabled = jest.fn();
const mockUnregister = jest.fn();
const mockRegisterPPLLintBridge = jest.fn((_bridge: unknown) => mockUnregister);
const mockLintRuntimePPLQuery = jest.fn();

jest.mock('@osd/monaco', () => ({
  setPPLLintEnabled: (enabled: boolean) => mockSetPPLLintEnabled(enabled),
  registerPPLLintBridge: (bridge: unknown) => mockRegisterPPLLintBridge(bridge),
}));

jest.mock('../../../data/public', () => ({
  lintRuntimePPLQuery: (...args: unknown[]) => mockLintRuntimePPLQuery(...args),
}));

import { registerPplLint } from './register_ppl_lint';

describe('registerPplLint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('disables the engine and registers no bridge when the capability is off', () => {
    const disposer = registerPplLint(false);

    expect(mockSetPPLLintEnabled).toHaveBeenCalledWith(false);
    expect(mockRegisterPPLLintBridge).not.toHaveBeenCalled();
    expect(disposer).toBeUndefined();
  });

  it('enables the engine and registers the lint bridge when the capability is on', () => {
    const disposer = registerPplLint(true);

    expect(mockSetPPLLintEnabled).toHaveBeenCalledWith(true);
    expect(mockRegisterPPLLintBridge).toHaveBeenCalledTimes(1);
    // The runtime lint function from the data plugin is passed as the bridge.
    expect(mockRegisterPPLLintBridge).toHaveBeenCalledWith(expect.any(Function));
    expect(disposer).toBe(mockUnregister);
  });

  it('returns a disposer that unregisters the bridge', () => {
    const disposer = registerPplLint(true);
    disposer?.();
    expect(mockUnregister).toHaveBeenCalledTimes(1);
  });
});
