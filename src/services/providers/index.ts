import {
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

import { codebuffProviderRuntime } from "./codebuff"
import { copilotProviderRuntime } from "./copilot"
import { mimoProviderRuntime } from "./mimo"
import { createOAuthProviderRuntime } from "./oauth"
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

  for (const providerId of OAUTH_PROVIDER_IDS) {
    const runtime = createOAuthProviderRuntime(providerId)
    runtime.adapter = getProtocolAdapter(PROVIDER_PROTOCOL_MAP[providerId])
    registerProvider(runtime)
  }
  initialized = true
}
