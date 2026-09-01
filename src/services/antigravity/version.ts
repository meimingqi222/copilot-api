/**
 * Antigravity 客户端版本动态追踪。
 *
 * 原生 Antigravity Hub 客户端通过 electron-builder 的自动更新 manifest
 * 获取最新版本号。这里复刻同样的逻辑，每 6 小时拉取一次 manifest，
 * 保持 User-Agent 中的版本号与官方客户端同步。
 *
 * Cloud Code 后端会拒绝低于 2.9.0 的客户端访问新模型，因此 fallback
 * 版本必须保持在或高于该下限。
 */

const ANTIGRAVITY_FALLBACK_VERSION = "2.9.1"
const ANTIGRAVITY_HUB_PLATFORM = "darwin/arm64"
const ANTIGRAVITY_VERSION_CACHE_TTL = 6 * 60 * 60 * 1000 // 6 小时
const ANTIGRAVITY_FETCH_TIMEOUT = 10_000
const ANTIGRAVITY_HUB_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml"

let cachedVersion: string = ANTIGRAVITY_FALLBACK_VERSION
let versionExpiry = 0
let updaterStarted = false

/**
 * 从 Hub manifest 拉取最新版本号。
 * manifest 是 YAML 格式，包含 `version: x.y.z` 字段。
 */
async function fetchLatestVersion(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ANTIGRAVITY_FETCH_TIMEOUT)
  try {
    const response = await fetch(ANTIGRAVITY_HUB_MANIFEST_URL, {
      headers: {
        "User-Agent": "electron-builder",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(
        `Antigravity Hub manifest returned status ${response.status}`,
      )
    }
    const text = await response.text()
    const match = text.match(/^version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m)
    if (!match?.[1]) {
      throw new Error("Antigravity Hub manifest missing valid version field")
    }
    return match[1]
  } finally {
    clearTimeout(timer)
  }
}

function refreshVersion(): void {
  fetchLatestVersion()
    .then((version) => {
      cachedVersion = version
      versionExpiry = Date.now() + ANTIGRAVITY_VERSION_CACHE_TTL
    })
    .catch(() => {
      // 拉取失败时：如果缓存已过期则回退到 fallback，否则保留旧值
      if (Date.now() >= versionExpiry) {
        cachedVersion = ANTIGRAVITY_FALLBACK_VERSION
        versionExpiry = Date.now() + ANTIGRAVITY_VERSION_CACHE_TTL
      }
    })
}

/**
 * 启动后台版本更新器。在服务启动时调用一次即可。
 * 使用 setTimeout 轮询而非 setInterval，避免请求堆积。
 */
export function startAntigravityVersionUpdater(): void {
  if (updaterStarted) return
  updaterStarted = true

  refreshVersion()

  const scheduleNext = () => {
    setTimeout(() => {
      refreshVersion()
      scheduleNext()
    }, ANTIGRAVITY_VERSION_CACHE_TTL / 2)
  }
  scheduleNext()
}

/**
 * 返回当前缓存的 Antigravity 最新版本号。
 * 如果缓存为空或已过期，返回 fallback 版本。
 */
export function getAntigravityLatestVersion(): string {
  if (cachedVersion && Date.now() < versionExpiry) {
    return cachedVersion
  }
  return ANTIGRAVITY_FALLBACK_VERSION
}

/**
 * 构建短 UA（用于 generate/stream/model-list 请求）。
 * 格式：antigravity/hub/<version> darwin/arm64
 */
export function buildAntigravityHubUserAgent(): string {
  return `antigravity/hub/${getAntigravityLatestVersion()} ${ANTIGRAVITY_HUB_PLATFORM}`
}

/**
 * 构建长 UA（用于 onboardUser 控制面请求）。
 * 在短 UA 基础上追加 google-api-nodejs-client 版本。
 */
export function buildAntigravityOnboardUserAgent(): string {
  return `${buildAntigravityHubUserAgent()} google-api-nodejs-client/10.3.0`
}

/**
 * OAuth token refresh 专用 UA。
 * 原生 Antigravity 使用 Go 的默认 HTTP 客户端刷新 token，
 * 因此 User-Agent 是 Go-http-client/2.0 而非 antigravity/hub/...。
 */
export const ANTIGRAVITY_OAUTH_REFRESH_USER_AGENT = "Go-http-client/2.0"
