import { websocket as honoWebsocket } from "hono/bun"

import { MAX_JSON_BODY_BYTES } from "~/lib/request-body"

/**
 * Keep Bun's transport ceiling just above the application JSON limit so the
 * Responses handler can return a structured error for oversized messages
 * without allowing an arbitrarily large frame to reach JavaScript.
 */
const WEBSOCKET_ENVELOPE_BYTES = 64 * 1024

/**
 * Shared Bun WebSocket handler. Hono only supplies the lifecycle callbacks;
 * the transport limits must be set on Bun's `websocket` options object.
 */
export const bunWebsocket = {
  ...honoWebsocket,
  maxPayloadLength: MAX_JSON_BODY_BYTES + WEBSOCKET_ENVELOPE_BYTES,
  backpressureLimit: 4 * 1024 * 1024,
  closeOnBackpressureLimit: false,
  idleTimeout: 120,
  sendPings: true,
}
