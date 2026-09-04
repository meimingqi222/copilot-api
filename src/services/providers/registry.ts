/**
 * Provider Runtime 注册表。
 *
 * 本注册表注册的是 **runtimes**(按账户/连接类型的生命周期管理):
 * refreshAuth / refreshQuota / refreshModels / getFallbackModels / supports。
 * 每个 runtime 绑定一个 ProviderId(copilot/claude/codex/xai/...)。
 *
 * 与 services/protocols/registry.ts 的区别:
 * - 本注册表 → runtimes(生命周期管理:token/quota/model 刷新)
 * - protocols/registry → wire adapters(协议适配:chat/messages/responses 互转)
 * 两者是正交维度,不合并。
 */
import type { ProviderDescriptor, ProviderId } from "~/lib/provider-config"

import type { ProviderRuntime } from "./runtime"

const providerRegistry = new Map<ProviderId, ProviderRuntime>()

export function registerProvider(runtime: ProviderRuntime): void {
  providerRegistry.set(runtime.id, runtime)
}

export function getProviderRuntime(provider: ProviderId): ProviderRuntime {
  const runtime = providerRegistry.get(provider)
  if (!runtime) {
    throw new Error(`Provider runtime "${provider}" is not registered`)
  }
  return runtime
}

export function listProviderDescriptors(): Array<ProviderDescriptor> {
  return Array.from(providerRegistry.values()).map(
    (runtime) => runtime.descriptor,
  )
}
