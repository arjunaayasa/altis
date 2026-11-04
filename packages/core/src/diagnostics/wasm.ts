// P19: WebAssembly on shared hosts. Node reserves a large virtual-memory region per WebAssembly memory for its trap
// handler; under a CloudLinux LVE or a low `ulimit -v` that reservation fails, and so does anything that uses
// WebAssembly (some dependencies do). Starting Node with the trap handler off fixes it. Diagnostik, the wizard's
// preflight and `doctor` probe it the same way.

/** What the admin is told to set when the probe fails. */
export const WASM_HINT = 'NODE_OPTIONS=--disable-wasm-trap-handler';

/** The part of the WebAssembly global the probe uses (lib ES2023 does not declare it). */
interface WasmGlobal {
  Memory: new (descriptor: { initial: number }) => { buffer: ArrayBuffer };
}

/**
 * Allocates one page of WebAssembly memory (`new WebAssembly.Memory({initial: 1})`): `{ok: true, hint: null}` when it
 * works; `{ok: false, hint: WASM_HINT}` when it throws or there is no WebAssembly at all. Never throws.
 */
export function wasmProbe(): { ok: boolean; hint: string | null } {
  try {
    const wasm = (globalThis as { WebAssembly?: WasmGlobal }).WebAssembly;
    if (wasm === undefined || wasm === null) return { ok: false, hint: WASM_HINT };
    const memory = new wasm.Memory({ initial: 1 });
    return memory.buffer.byteLength > 0 ? { ok: true, hint: null } : { ok: false, hint: WASM_HINT };
  } catch {
    return { ok: false, hint: WASM_HINT };
  }
}
