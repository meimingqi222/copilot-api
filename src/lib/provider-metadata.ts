import { providerMetadata as antigravityMetadata } from "~/lib/provider-descriptors/antigravity"
import { providerMetadata as claudeMetadata } from "~/lib/provider-descriptors/claude"
import {
  codebuddyCnMetadata,
  codebuddyMetadata,
} from "~/lib/provider-descriptors/codebuddy"
import { providerMetadata as codebuffMetadata } from "~/lib/provider-descriptors/codebuff"
import { providerMetadata as codexMetadata } from "~/lib/provider-descriptors/codex"
import { providerMetadata as commandCodePlanMetadata } from "~/lib/provider-descriptors/commandcode-plan"
import { providerMetadata as copilotMetadata } from "~/lib/provider-descriptors/copilot"
import { providerMetadata as dimagentMetadata } from "~/lib/provider-descriptors/dimagent"
import { providerMetadata as factoryMetadata } from "~/lib/provider-descriptors/factory"
import { providerMetadata as geminiMetadata } from "~/lib/provider-descriptors/gemini"
import { providerMetadata as kimiMetadata } from "~/lib/provider-descriptors/kimi"
import { providerMetadata as lobsteraiMetadata } from "~/lib/provider-descriptors/lobsterai"
import { providerMetadata as mimoMetadata } from "~/lib/provider-descriptors/mimo-aistudio"
import { providerMetadata as minimaxMetadata } from "~/lib/provider-descriptors/minimax"
import { providerMetadata as qoderMetadata } from "~/lib/provider-descriptors/qoder"
import { providerMetadata as qoderCnMetadata } from "~/lib/provider-descriptors/qoder-cn"
import { providerMetadata as traeCnMetadata } from "~/lib/provider-descriptors/trae-cn"
import { providerMetadata as windsurfMetadata } from "~/lib/provider-descriptors/windsurf"
import { providerMetadata as xaiMetadata } from "~/lib/provider-descriptors/xai"
import { providerMetadata as zcodeMetadata } from "~/lib/provider-descriptors/zcode"
import { providerMetadata as zedMetadata } from "~/lib/provider-descriptors/zed"
import { createProviderMetadataCatalog } from "~/lib/provider-descriptors/metadata"

/** The only pure metadata assembly list; identity is declared by each contribution. */
export const PROVIDER_METADATA_ENTRIES = [
  copilotMetadata,
  codebuffMetadata,
  windsurfMetadata,
  mimoMetadata,
  codexMetadata,
  claudeMetadata,
  antigravityMetadata,
  kimiMetadata,
  xaiMetadata,
  codebuddyMetadata,
  codebuddyCnMetadata,
  lobsteraiMetadata,
  minimaxMetadata,
  qoderMetadata,
  qoderCnMetadata,
  factoryMetadata,
  zcodeMetadata,
  commandCodePlanMetadata,
  zedMetadata,
  dimagentMetadata,
  geminiMetadata,
  traeCnMetadata,
] as const

export const PROVIDER_METADATA = createProviderMetadataCatalog(
  PROVIDER_METADATA_ENTRIES,
)
