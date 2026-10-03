import { isProviderId, type ProviderId } from "~/lib/provider-config"
import type { ProviderModule } from "~/services/providers/module"
import { getCopilotModule } from "~/services/providers/modules/copilot"
import { getCodebuffModule } from "~/services/providers/modules/codebuff"
import { getWindsurfModule } from "~/services/providers/modules/windsurf"
import { getMimoModule } from "~/services/providers/modules/mimo-aistudio"
import { getCodexModule } from "~/services/providers/modules/codex"
import { getClaudeModule } from "~/services/providers/modules/claude"
import { getAntigravityModule } from "~/services/providers/modules/antigravity"
import { getKimiModule } from "~/services/providers/modules/kimi"
import { getXaiModule } from "~/services/providers/modules/xai"
import { getCodebuddyModule } from "~/services/providers/modules/codebuddy"
import { getCodebuddyCnModule } from "~/services/providers/modules/codebuddy-cn"
import { getLobsteraiModule } from "~/services/providers/modules/lobsterai"
import { getMinimaxModule } from "~/services/providers/modules/minimax"
import { getQoderModule } from "~/services/providers/modules/qoder"
import { getFactoryModule } from "~/services/providers/modules/factory"
import { getZcodeModule } from "~/services/providers/modules/zcode"
import { getCommandCodeModule } from "~/services/providers/modules/commandcode-plan"
import { getZedModule } from "~/services/providers/modules/zed"
import { getDimagentModule } from "~/services/providers/modules/dimagent"
import { getGeminiModule } from "~/services/providers/modules/gemini"

// Factories keep registration independent of module import order.
const modules: Record<ProviderId, () => ProviderModule> = {
  copilot: getCopilotModule,
  codebuff: getCodebuffModule,
  windsurf: getWindsurfModule,
  "mimo-aistudio": getMimoModule,
  codebuddy: getCodebuddyModule,
  "codebuddy-cn": getCodebuddyCnModule,
  lobsterai: getLobsteraiModule,
  qoder: getQoderModule,
  "commandcode-plan": getCommandCodeModule,
  codex: getCodexModule,
  claude: getClaudeModule,
  antigravity: getAntigravityModule,
  kimi: getKimiModule,
  xai: getXaiModule,
  minimax: getMinimaxModule,
  factory: getFactoryModule,
  zcode: getZcodeModule,
  zed: getZedModule,
  dimagent: getDimagentModule,
  gemini: getGeminiModule,
}

export function listBuiltinProviderModules(): Array<ProviderModule> {
  return Object.values(modules).map((create) => create())
}

export function getBuiltinProviderModule(
  id: string,
): ProviderModule | undefined {
  return isProviderId(id) ? modules[id]() : undefined
}
