import { initializeProtocolAdapters } from "~/services/protocols"
import { listBuiltinProviderModules } from "~/services/providers/builtins"
import { registerProvider } from "~/services/providers/registry"

let initialized = false

export function initializeProviderRegistry(): void {
  if (initialized) return
  const modules = listBuiltinProviderModules()
  // 校验只做一次:initializeProtocolAdapters 内部对同一份模块列表
  // 跑 validateProviderModules(无论谁先初始化都会经过那里)。
  initializeProtocolAdapters()
  const runtimes = modules.map((module) => {
    const runtime = module.createRuntime()
    if (runtime.id !== module.id || runtime.descriptor.id !== module.id) {
      throw new Error(`Provider runtime does not match module "${module.id}"`)
    }
    runtime.adapter = module.adapter
    return runtime
  })
  for (const runtime of runtimes) registerProvider(runtime)
  initialized = true
}
