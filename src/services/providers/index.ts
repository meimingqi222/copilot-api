import { codebuffProviderRuntime } from "./codebuff"
import { copilotProviderRuntime } from "./copilot"
import { mimoProviderRuntime } from "./mimo"
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
  initialized = true
}
