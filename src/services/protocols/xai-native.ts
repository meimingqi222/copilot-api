/**
 * xAI Native Protocol Adapter。
 *
 * 上游是 Responses API；协议差异（protocol 名 + 发请求实现）交给
 * `createResponsesNativeAdapter`，与 Codex 共用同一份适配器骨架。
 */

import { createXaiResponsesOnce } from "~/services/xai/create-responses-once"

import { createResponsesNativeAdapter } from "./responses-native"

export const xaiNativeAdapter = createResponsesNativeAdapter(
  "xai-native",
  createXaiResponsesOnce,
)
