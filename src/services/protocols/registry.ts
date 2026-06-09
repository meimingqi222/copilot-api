/**
 * Protocol Adapter 注册表。Adapter 按 protocol id 注册,connection 根据
 * 自身 protocol 字段查找对应 adapter。
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
