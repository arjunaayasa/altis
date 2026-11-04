import { afterEach, describe, expect, it, vi } from 'vitest';
import { WASM_HINT, wasmProbe } from '../src/diagnostics/wasm.js';

// P19: some hosts (CloudLinux LVE, a low virtual-memory limit) refuse to reserve WebAssembly memory unless Node runs
// with the trap handler off; Diagnostik and the wizard's preflight show the hint.

describe('wasmProbe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allocates one page on this Node: ok, no hint', () => {
    expect(wasmProbe()).toEqual({ ok: true, hint: null });
  });

  it('WebAssembly.Memory throwing → not ok, with the NODE_OPTIONS hint', () => {
    vi.stubGlobal('WebAssembly', {
      Memory: class {
        constructor() {
          throw new RangeError('WebAssembly.Memory(): could not allocate memory');
        }
      },
    });
    expect(wasmProbe()).toEqual({ ok: false, hint: 'NODE_OPTIONS=--disable-wasm-trap-handler' });
    expect(WASM_HINT).toBe('NODE_OPTIONS=--disable-wasm-trap-handler');
  });

  it('no WebAssembly at all (a Node built without it) → not ok, with the hint', () => {
    vi.stubGlobal('WebAssembly', undefined);
    expect(wasmProbe()).toEqual({ ok: false, hint: WASM_HINT });
  });
});
