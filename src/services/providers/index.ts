import {
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

import {
  codebuddyCnProviderRuntime,
  codebuddyProviderRuntime,
} from "./codebuddy"
import { codebuffProviderRuntime } from "./codebuff"
import { copilotProviderRuntime } from "./copilot"
import { lobsteraiProviderRuntime } from "./lobsterai"
import { mimoProviderRuntime } from "./mimo"
import { createOAuthProviderRuntime } from "./oauth"
import { qoderProviderRuntime } from "./qoder"
import { commandCodeProviderRuntime } from "./commandcode"
import { registerProvider } from "./registry"
import { windsurfProviderRuntime } from "./windsurf"

let initialized = false

export function initializeProviderRegistry(): void {
  if (initialized) {
    return
  }

  initializeProtocolAdapters()

  copilotProviderRuntime.adapter = getProtocolAdapter("copilot-native")
  registerProvider(copilotProviderRuntime)

  codebuffProviderRuntime.adapter = getProtocolAdapter("codebuff-native")
  registerProvider(codebuffProviderRuntime)

  windsurfProviderRuntime.adapter = getProtocolAdapter("windsurf-native")
  registerProvider(windsurfProviderRuntime)

  mimoProviderRuntime.adapter = getProtocolAdapter("mimo-native")
  registerProvider(mimoProviderRuntime)

  codebuddyProviderRuntime.adapter = getProtocolAdapter("codebuddy-native")
  registerProvider(codebuddyProviderRuntime)

  codebuddyCnProviderRuntime.adapter = getProtocolAdapter("codebuddy-native")
  registerProvider(codebuddyCnProviderRuntime)

  lobsteraiProviderRuntime.adapter = getProtocolAdapter("lobsterai-native")
  registerProvider(lobsteraiProviderRuntime)

  // Qoder 需要自己的 runtime（模型发现走 adapter），单独注册；
  // 其余 OAuth provider 用通用 runtime 即可。
  qoderProviderRuntime.adapter = getProtocolAdapter("qoder-native")
  registerProvider(qoderProviderRuntime)

  // Command Code 的模型走 adapter 的 discoverModels，同样单独注册。
  commandCodeProviderRuntime.adapter = getProtocolAdapter("commandcode-native")
  registerProvider(commandCodeProviderRuntime)

  for (const providerId of OAUTH_PROVIDER_IDS) {
    if (providerId === "qoder") continue
    if (providerId === "commandcode-plan") continue
    const runtime = createOAuthProviderRuntime(providerId)
    runtime.adapter = getProtocolAdapter(PROVIDER_PROTOCOL_MAP[providerId])
    registerProvider(runtime)
  }
  initialized = true
}
