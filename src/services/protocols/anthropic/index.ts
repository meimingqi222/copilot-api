/**
 * Anthropic protocol types and helpers.
 *
 * The OpenAI<->Anthropic translation itself now lives in the shared IR codecs
 * (`src/services/ir/codecs/messages-chat`); only the types, the stop-reason
 * map and the error-event shaper remain here.
 */

export * from "./types"
export * from "./utils"
