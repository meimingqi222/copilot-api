/** Pure metadata, available before runtime initialization and while loading persisted connections. */
export const PROVIDER_DEFINITIONS = {
  copilot: { protocol: "copilot-native", oauth: false },
  codebuff: { protocol: "codebuff-native", oauth: false },
  windsurf: { protocol: "windsurf-native", oauth: false },
  "mimo-aistudio": { protocol: "mimo-native", oauth: false },
  codex: { protocol: "codex-native", oauth: true },
  claude: { protocol: "claude-native", oauth: true },
  antigravity: { protocol: "antigravity-native", oauth: true },
  kimi: { protocol: "kimi-native", oauth: true },
  xai: { protocol: "xai-native", oauth: true },
  codebuddy: { protocol: "codebuddy-native", oauth: false },
  "codebuddy-cn": { protocol: "codebuddy-native", oauth: false },
  lobsterai: { protocol: "lobsterai-native", oauth: false },
  minimax: { protocol: "minimax-native", oauth: true },
  qoder: { protocol: "qoder-native", oauth: true },
  factory: { protocol: "factory-native", oauth: true },
  zcode: { protocol: "zcode-native", oauth: true },
  "commandcode-plan": { protocol: "commandcode-native", oauth: true },
  zed: { protocol: "zed-native", oauth: true },
  dimagent: { protocol: "dimagent-native", oauth: true },
  gemini: { protocol: "gemini-native", oauth: true },
} as const

export type ProviderId = keyof typeof PROVIDER_DEFINITIONS
export type NativeProviderProtocol =
  (typeof PROVIDER_DEFINITIONS)[ProviderId]["protocol"]
export type OAuthProviderId = {
  [K in ProviderId]: (typeof PROVIDER_DEFINITIONS)[K]["oauth"] extends true ? K
  : never
}[ProviderId]

export const PROVIDER_IDS = Object.keys(
  PROVIDER_DEFINITIONS,
) as Array<ProviderId>
export const OAUTH_PROVIDER_IDS = PROVIDER_IDS.filter(
  (id): id is OAuthProviderId => PROVIDER_DEFINITIONS[id].oauth,
)
export const PROVIDER_PROTOCOL_MAP = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, PROVIDER_DEFINITIONS[id].protocol]),
) as Record<ProviderId, NativeProviderProtocol>
