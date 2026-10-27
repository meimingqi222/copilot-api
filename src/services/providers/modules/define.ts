import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderModule } from "~/services/providers/module"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"

/**
 * OAuth provider 模块的样板由 id 推导：descriptor 与 runtime 不再由各模块
 * 手写（写错只会在启动校验时才报错），模块文件只声明真正不同的部分——
 * adapter、登录策略、刷新、配额、模型发现。
 */
export function defineOAuthProviderModule(
  input: Omit<ProviderModule, "id" | "descriptor" | "createRuntime"> & {
    id: OAuthProviderId
  },
): ProviderModule {
  return {
    ...input,
    descriptor: getProviderDescriptor(input.id),
    createRuntime: () => createOAuthProviderRuntime(input.id),
  }
}
