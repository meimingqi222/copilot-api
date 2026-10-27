/**
 * Codex Native Protocol Adapter。
 *
 * 上游是 Responses API；协议差异（protocol 名 + 发请求实现）交给
 * `createResponsesNativeAdapter`，与 xAI 共用同一份适配器骨架。
 */

import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"

import { createResponsesNativeAdapter } from "./responses-native"

export const codexNativeAdapter = createResponsesNativeAdapter(
  "codex-native",
  createCodexResponsesOnce,
)
