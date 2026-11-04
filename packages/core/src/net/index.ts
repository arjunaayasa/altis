// Outbound HTTP (spec §6.1; Phase 2). Task 3 created the seam (a stub `httpRequest` with its final signature); Task 9
// filled it and added its own names here (`isBlockedAddress`, the `OUTBOUND_*` limits). `isForbiddenAddress` and
// `LookupFn` stay out of the barrel (helpers of the client, M14).

export {
  OUTBOUND_CONNECT_MS,
  OUTBOUND_MAX_BYTES,
  OUTBOUND_MAX_REDIRECTS,
  OUTBOUND_TOTAL_MS,
  httpRequest,
} from './http.js';
export type { OutboundFailure, OutboundRequest, OutboundResponse } from './http.js';
export { isBlockedAddress } from './ssrf.js';
