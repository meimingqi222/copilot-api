import type { ProviderId } from "~/lib/provider-definitions"
import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { descriptor as antigravityDescriptor } from "./antigravity"
import { descriptor as claudeDescriptor } from "./claude"
import { codebuddyCnDescriptor, codebuddyDescriptor } from "./codebuddy"
import { descriptor as codebuffDescriptor } from "./codebuff"
import { descriptor as codexDescriptor } from "./codex"
import { descriptor as commandCodePlanDescriptor } from "./commandcode-plan"
import { descriptor as copilotDescriptor } from "./copilot"
import { descriptor as dimagentDescriptor } from "./dimagent"
import { descriptor as factoryDescriptor } from "./factory"
import { descriptor as geminiDescriptor } from "./gemini"
import { descriptor as kimiDescriptor } from "./kimi"
import { descriptor as lobsteraiDescriptor } from "./lobsterai"
import { descriptor as mimoDescriptor } from "./mimo-aistudio"
import { descriptor as minimaxDescriptor } from "./minimax"
import { descriptor as qoderDescriptor } from "./qoder"
import { descriptor as windsurfDescriptor } from "./windsurf"
import { descriptor as xaiDescriptor } from "./xai"
import { descriptor as zcodeDescriptor } from "./zcode"
import { descriptor as zedDescriptor } from "./zed"

/**
 * 各 Provider 的账号描述与登录表单字段。纯数据:管理界面与路由能力判断
 * 在 runtime 启动前读取,模块注册时与 `module.id` 做一致性校验。
 */
export const PROVIDER_DESCRIPTORS: Record<ProviderId, ProviderDescriptor> = {
  copilot: copilotDescriptor,
  codebuff: codebuffDescriptor,
  windsurf: windsurfDescriptor,
  "mimo-aistudio": mimoDescriptor,
  codex: codexDescriptor,
  claude: claudeDescriptor,
  antigravity: antigravityDescriptor,
  kimi: kimiDescriptor,
  xai: xaiDescriptor,
  codebuddy: codebuddyDescriptor,
  "codebuddy-cn": codebuddyCnDescriptor,
  lobsterai: lobsteraiDescriptor,
  minimax: minimaxDescriptor,
  qoder: qoderDescriptor,
  factory: factoryDescriptor,
  zcode: zcodeDescriptor,
  "commandcode-plan": commandCodePlanDescriptor,
  zed: zedDescriptor,
  dimagent: dimagentDescriptor,
  gemini: geminiDescriptor,
}

export function getProviderDescriptor(id: ProviderId): ProviderDescriptor {
  return PROVIDER_DESCRIPTORS[id]
}

export type {
  ProviderDescriptor,
  ProviderFeature,
  ProviderFieldOption,
  ProviderFieldSchema,
} from "~/lib/provider-descriptors/types"
export { PROVIDER_FEATURES } from "~/lib/provider-descriptors/types"
