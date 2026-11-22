// Load @livekit/rtc-node with the native SDK's log capture turned off.
//
// rtc-node starts its FFI with captureLogs=true and so forwards every Rust/libwebrtc log
// record, TRACE included, into JavaScript as events. On a host with many network interfaces
// (dev2 has ~200 docker bridges) ICE gathering alone logs tens of thousands of records a second:
// the event queue outgrew a 768 MB heap within two connections and the service was OOM-killed.
// With capture off the native side logs through its own logger (RUST_LOG, quiet by default).
// This must run before rtc-node creates its FFI client, so it goes through require() (the CJS
// build reads the binding's property at call time) rather than a static ESM import.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let mod = null;

export function loadRtc() {
  if (mod) return mod;
  const bindings = require('@livekit/rtc-ffi-bindings');
  if (!globalThis._ffiClientInstance && !bindings.__boardQuiet) {
    const init = bindings.livekitInitialize;
    bindings.livekitInitialize = (cb, _captureLogs, version) => init(cb, false, version);
    bindings.__boardQuiet = true;
  }
  mod = require('@livekit/rtc-node');
  return mod;
}
