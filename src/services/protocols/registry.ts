/**
 * Protocol Adapter 注册表(Wire Adapters)。
 *
 * 本注册表注册的是 **wire adapters**(协议适配层):
 * 12 个 adapter = 3 个 `*-compatible`(openai/openai-responses/anthropic)
 * + 9 个 `*-native`(copilot/claude/codex/xai/kimi/antigravity/windsurf/codebuff/mimo)。
 * 每个 adapter 按 ProviderProtocol 注册,connection 根据自身 protocol 字段查找。
 *
 * 与 services/providers/registry.ts 的区别:
 * - 本注册表 → wire adapters(协议适配:请求/响应格式转换)
 * - providers/registry → runtimes(生命周期管理:token/quota/model 刷新)
 * 两者是正交维度,不合并。
 */

import type { ProviderProtocol } from "~/lib/provider-connections"

import type { ProtocolAdapter } from "./types"

const registry = new Map<ProviderProtocol, ProtocolAdapter>()

export function registerProtocolAdapter(adapter: ProtocolAdapter): void {
  if (registry.has(adapter.protocol)) {
    throw new Error(`Protocol adapter already registered: ${adapter.protocol}`)
  }
  registry.set(adapter.protocol, adapter)
}

export function getProtocolAdapter(
  protocol: ProviderProtocol,
): ProtocolAdapter | undefined {
  return registry.get(protocol)
}
