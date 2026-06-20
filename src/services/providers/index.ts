import { OAUTH_PROVIDER_IDS } from "~/lib/provider-config"

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

  registerProvider(copilotProviderRuntime)
  registerProvider(codebuffProviderRuntime)
  registerProvider(windsurfProviderRuntime)
  registerProvider(mimoProviderRuntime)
  for (const providerId of OAUTH_PROVIDER_IDS) {
    registerProvider(createOAuthProviderRuntime(providerId))
  }
  initialized = true
}
