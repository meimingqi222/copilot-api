/**
 * ZCode (Z.ai GLM Coding Plan) OAuth：ZCode 自己的轮询登录 → 铸 API key。
 *
 * 流程（Z.ai 站点 "zai"；BigModel 站点 "bigmodel" 同构，域不同）：
 *
 *   init   POST https://zcode.z.ai/api/v1/oauth/cli/init   Authorization: Bearer <poll>
 *          body {provider:"zai"} → { flow_id, authorize_url, expires_at, poll_interval_sec }
 *   poll   GET  https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}   Authorization: Bearer <poll>
 *          → { status, token, zai:{access_token}, user:{user_id,email,name} }
 *   biz    POST https://api.z.ai/api/auth/z/login           body {token} → {access_token}
 *   info   GET  https://api.z.ai/api/biz/customer/getCustomerInfo   Authorization: Bearer <biz>
 *   mint   GET/POST .../organization/{org}/projects/{proj}/api_keys
 *          → 找到或创建名为 `zcode-api-key` 的 key，再 copy 出 secret → `<id>.<secret>`
 *
 * 计划端点（Anthropic 兼容）：`https://api.z.ai/api/anthropic`（BigModel：
 * `https://open.bigmodel.cn/api/anthropic`）。chat 用 `<id>.<secret>` 作
 * `x-api-key` + `Authorization: Bearer <id>.<secret>`（见 zcode-native.ts）。
 * key 是长期凭证，不轮换，因此没有 refresh。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { setCredentialContextField } from "~/lib/provider-connections"
import { asRecord } from "~/lib/json-shape"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"
import { delay } from "~/lib/delay"
import { asStringOrEmpty } from "~/lib/json-shape"

export const ZCODE_API = "https://zcode.z.ai"
/**
 * ZCode 桌面端版本兜底值（对话与 billing 头都用它）。
 *
 * 活动套餐投放按最低客户端版本投：钉旧版时 billing/preview 会恒空
 * ——这是「明明有套餐却领不到」的头号原因，不是账号不符合条件。
 * 2026-10-29 实测：3.14.4 返回 `plans: []`，3.16.3（本机 ZCode
 * 客户端 app.asar 里的 ri 常量）起才投 `ZCODE GLOBAL BUILD`。
 *
 * 领取链路已改为读官方版本清单（resolveZcodeAppVersion），这个值只在
 * 清单拉不到时兜底；对话路径仍直接用它。
 */
export const ZCODE_APP_VERSION = "3.16.3"

/**
 * 官方 electron 版本清单（更新器用的同一个端点，免鉴权，返回 YAML）。
 *
 *   GET {zcode}/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=stable
 *   → version: 3.16.3 ...
 *
 * 活动套餐按最低客户端版本投放，硬编码的版本一旦落后，preview 会静默
 * 返回空列表（看起来像「账号不符合条件」）。所以运行时读官方清单，把
 * 上面的常量当兜底。
 */
const RELEASE_MANIFEST_URL = `${ZCODE_API}/api/v1/releases/electron/manifest`
/** 官方发版不频繁；6 小时足够跟上，又不至于每次领取都打一次。 */
const APP_VERSION_TTL_MS = 6 * 60 * 60 * 1000
/** 清单拉不到时短退避，避免每个账号每轮都重试一次。 */
const APP_VERSION_RETRY_MS = 10 * 60 * 1000
const APP_VERSION_TIMEOUT_MS = 10_000

let cachedAppVersion: { value: string; at: number; ttlMs: number } | undefined
let appVersionTask: Promise<string> | undefined

/** 更新器的平台键：windows-x86_64 / darwin-arm64 / linux-x86_64。 */
function releasePlatformKey(): string {
  const platform =
    process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "darwin"
    : process.platform
  const arch =
    process.arch === "x64" ? "x86_64"
    : process.arch === "ia32" ? "x86"
    : process.arch
  return `${platform}-${arch}`
}

function semverParts(value: string): Array<number> | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(value.trim())
  return match ?
      [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined
}

/** 取两者中较新的版本，忽略无法解析的一侧。 */
function newestVersion(a: string, b: string): string {
  const pa = semverParts(a)
  const pb = semverParts(b)
  if (!pa) return b
  if (!pb) return a
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i]! > pb[i]! ? a : b
  }
  return a
}

/** 从更新器清单里读 `version:`（YAML 只为取一行，不引依赖）。 */
function parseReleaseManifestVersion(text: string): string | undefined {
  const match = /^version:\s*["']?([\w.+-]+)["']?\s*$/m.exec(text)
  const value = match?.[1]?.trim()
  return value && semverParts(value) ? value : undefined
}

/** 清单里的版本；拉取失败返回 undefined，由调用方决定退避时长。 */
async function fetchZcodeAppVersion(options?: {
  signal?: AbortSignal
  proxyUrl?: string
}): Promise<string | undefined> {
  const url = `${RELEASE_MANIFEST_URL}?platform=${encodeURIComponent(
    releasePlatformKey(),
  )}&channel=stable`
  try {
    const response = await oauthFetch(
      url,
      {
        headers: {
          accept: "application/x-yaml,text/yaml,text/plain,*/*",
          "user-agent": `ZCode/${ZCODE_APP_VERSION}`,
        },
        signal: options?.signal ?? AbortSignal.timeout(APP_VERSION_TIMEOUT_MS),
      },
      options?.proxyUrl ? { proxyUrl: options.proxyUrl } : undefined,
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const version = parseReleaseManifestVersion(await response.text())
    if (!version) throw new Error("manifest carried no version")
    return version
  } catch (error) {
    logger.warn(
      `Could not read ZCode's release manifest, keeping ${ZCODE_APP_VERSION}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
}

/**
 * 当前官方客户端版本（活动套餐投放按它判定）。
 *
 * 读官方更新器清单并与常量取较新者，拉取失败就退回常量——旧版只会让
 * 「可领套餐」变空，不会报错，所以这里永不抛异常。
 */
export async function resolveZcodeAppVersion(options?: {
  signal?: AbortSignal
  proxyUrl?: string
}): Promise<string> {
  const now = Date.now()
  if (cachedAppVersion && now - cachedAppVersion.at < cachedAppVersion.ttlMs) {
    return cachedAppVersion.value
  }
  if (appVersionTask) return appVersionTask
  const task = fetchZcodeAppVersion(options)
    .then((fetched) => {
      cachedAppVersion =
        fetched ?
          {
            value: newestVersion(fetched, ZCODE_APP_VERSION),
            at: Date.now(),
            ttlMs: APP_VERSION_TTL_MS,
          }
        : {
            value: ZCODE_APP_VERSION,
            at: Date.now(),
            ttlMs: APP_VERSION_RETRY_MS,
          }
      return cachedAppVersion.value
    })
    .finally(() => {
      appVersionTask = undefined
    })
  appVersionTask = task
  return task
}

/** 测试用：清掉抓到的版本缓存。 */
export function __resetZcodeAppVersionForTest(): void {
  cachedAppVersion = undefined
  appVersionTask = undefined
}

export const ZCODE_ZAI_ANTHROPIC_BASE = "https://api.z.ai/api/anthropic"
export const ZCODE_BIGMODEL_ANTHROPIC_BASE =
  "https://open.bigmodel.cn/api/anthropic"
export const ZCODE_ZAI_BIZ_API = "https://api.z.ai"
export const ZCODE_BIGMODEL_BIZ_API = "https://bigmodel.cn"

export type ZcodeSite = "zai" | "bigmodel"

interface ZcodeSignInStart {
  flowId: string
  authUrl: string
  pollToken: string
  intervalMs: number
  expiresAtMs: number
}

interface ZcodeSignInResult {
  /** ZCode 会话 token（换 biz token 用）。 */
  sessionToken: string
  /**
   * ZCode 自己的会话 JWT（轮询返回的顶层 `token`）。
   * 账号走 Start Plan（临时积分 / 体验套餐）时它是请求凭证
   * （zcode.z.ai/api/v1/zcode-plan/… 的 Bearer），与换 biz 的
   * access_token 是两回事；存 credential.context.zcodeJwt。
   */
  jwt?: string
  email?: string
  userId?: string
}

interface ZcodeKeyBundle {
  /** 计划端点 base（Anthropic 兼容）。 */
  base: string
  /** 铸出的 key `<id>.<secret>`；铸不出来（纯 Start Plan 账号）为 ""。 */
  apiKey: string
  site: ZcodeSite
  /** ZCode 会话 JWT（Start Plan 通道用），见 ZcodeSignInResult。 */
  jwt?: string
  email?: string
  userId?: string
}

export function normalizeZcodeSite(value: string | undefined): ZcodeSite {
  return value === "bigmodel" ? "bigmodel" : "zai"
}

function zcodeBizApi(site: ZcodeSite): string {
  return site === "bigmodel" ? ZCODE_BIGMODEL_BIZ_API : ZCODE_ZAI_BIZ_API
}

function zcodeAnthropicBase(site: ZcodeSite): string {
  return site === "bigmodel" ?
      ZCODE_BIGMODEL_ANTHROPIC_BASE
    : ZCODE_ZAI_ANTHROPIC_BASE
}

function zcodeUserAgent(): string {
  return `ZCode/${ZCODE_APP_VERSION}`
}
/** Z.ai 的 JSON 端点把内容包在 {code,msg,data}：code 0/200 才算成功。 */
async function zcodeCall(
  url: string,
  init: RequestInit,
  options?: OAuthFetchOptions,
): Promise<unknown> {
  const response = await oauthFetch(
    url,
    {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": zcodeUserAgent(),
        ...(init.headers as Record<string, string> | undefined),
      },
    },
    options,
  )
  const text = await response.text()
  let env: Record<string, unknown> = {}
  try {
    env = (JSON.parse(text) as Record<string, unknown>) ?? {}
  } catch {
    env = {}
  }
  if (!response.ok) {
    const msg = asStringOrEmpty(env.msg)
    throw new HTTPError(
      msg ?
        `${msg} (${response.status})`
      : `ZCode request failed (${response.status})`,
      new Response(text || response.statusText, { status: response.status }),
      text,
    )
  }
  const code =
    typeof env.code === "number" ? String(env.code) : asStringOrEmpty(env.code)
  if (code && code !== "0" && code !== "200" && code !== "null") {
    throw new HTTPError(
      asStringOrEmpty(env.msg) || `ZCode error ${code}`,
      new Response(null, { status: 502 }),
      text,
    )
  }
  return env.data ?? null
}

function randomPollToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** 打开一个登录流程，返回授权页 URL 与轮询材料。 */
export async function startZcodeSignIn(
  site: ZcodeSite,
  options?: OAuthFetchOptions,
): Promise<ZcodeSignInStart> {
  const pollToken = randomPollToken()
  const data = asRecord(
    await zcodeCall(
      `${ZCODE_API}/api/v1/oauth/cli/init`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${pollToken}` },
        body: JSON.stringify({ provider: site }),
      },
      options,
    ),
  )
  const flowId = asStringOrEmpty(data?.flow_id)
  const rawUrl = asStringOrEmpty(data?.authorize_url)
  if (!flowId || !rawUrl) {
    throw new HTTPError(
      "ZCode gave no sign-in page",
      new Response(null, { status: 502 }),
      JSON.stringify(data),
    )
  }
  const url = new URL(rawUrl)
  if (url.protocol !== "https:") {
    throw new HTTPError(
      "ZCode sign-in URL is not https",
      new Response(null, { status: 502 }),
      rawUrl,
    )
  }
  const back = `${ZCODE_API}/app/oauth/login?redirect=${encodeURIComponent(
    "zcode://oauth/callback",
  )}&app_version=${encodeURIComponent(ZCODE_APP_VERSION)}`
  url.searchParams.set(site === "bigmodel" ? "redirect" : "redirect_uri", back)

  const intervalSec = Number(data?.poll_interval_sec) || 3
  const expiresSec = Number(data?.expires_at) || 0
  return {
    flowId,
    authUrl: url.toString(),
    pollToken,
    intervalMs: Math.max(intervalSec, 1) * 1000,
    expiresAtMs:
      expiresSec > 0 ? expiresSec * 1000 : Date.now() + 5 * 60 * 1000,
  }
}

/** 轮询登录流程直到 ready，返回会话 token 与身份。 */
async function pollZcodeSignIn(
  start: ZcodeSignInStart,
  site: ZcodeSite,
  options?: OAuthFetchOptions & { signal?: AbortSignal },
): Promise<ZcodeSignInResult> {
  for (;;) {
    if (options?.signal?.aborted) throw new Error("aborted")
    if (Date.now() > start.expiresAtMs) {
      throw new HTTPError(
        "ZCode sign-in expired — start again",
        new Response(null, { status: 408 }),
        "",
      )
    }
    await delay(start.intervalMs, options?.signal)

    const data = asRecord(
      await zcodeCall(
        `${ZCODE_API}/api/v1/oauth/cli/poll/${encodeURIComponent(start.flowId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${start.pollToken}` },
        },
        options,
      ),
    )
    const status = asStringOrEmpty(data?.status)
    if (status === "pending" || status === "") continue
    if (status === "failed") {
      throw new HTTPError(
        "ZCode sign-in was declined",
        new Response(null, { status: 403 }),
        "",
      )
    }
    if (status !== "ready") {
      throw new HTTPError(
        `ZCode sign-in: unexpected answer ${status}`,
        new Response(null, { status: 502 }),
        JSON.stringify(data),
      )
    }
    const siteBlock = asRecord(site === "bigmodel" ? data?.bigmodel : data?.zai)
    const sessionToken =
      asStringOrEmpty(siteBlock?.access_token)
      || asStringOrEmpty(siteBlock?.accessToken)
    if (!sessionToken) {
      throw new HTTPError(
        "ZCode sign-in returned no token",
        new Response(null, { status: 502 }),
        JSON.stringify(data),
      )
    }
    const user = asRecord(data?.user)
    return {
      sessionToken,
      // 顶层 token 是 ZCode 自己的会话 JWT（Start Plan 的凭证）。
      jwt: asStringOrEmpty(data?.token) || undefined,
      email: asStringOrEmpty(user?.email) || undefined,
      userId: asStringOrEmpty(user?.user_id) || undefined,
    }
  }
}

/** 换业务 API 的 Authorization（Z.ai 需要一次交换；BigModel 直接用）。 */
async function zcodeBizAuth(
  site: ZcodeSite,
  sessionToken: string,
  options?: OAuthFetchOptions,
): Promise<string> {
  if (site === "bigmodel") return sessionToken
  const data = asRecord(
    await zcodeCall(
      `${ZCODE_ZAI_BIZ_API}/api/auth/z/login`,
      { method: "POST", body: JSON.stringify({ token: sessionToken }) },
      options,
    ),
  )
  const bizToken = asStringOrEmpty(data?.access_token)
  if (!bizToken) {
    throw new HTTPError(
      "Z.ai sign-in: no business token",
      new Response(null, { status: 502 }),
      JSON.stringify(data),
    )
  }
  return `Bearer ${bizToken}`
}

/** 在默认机构/项目里找或创建 `zcode-api-key`，并读出 secret。 */
export async function mintZcodeKey(
  site: ZcodeSite,
  bizAuth: string,
  options?: OAuthFetchOptions,
): Promise<string> {
  const root = zcodeBizApi(site)
  const info = asRecord(
    await zcodeCall(
      `${root}/api/biz/customer/getCustomerInfo`,
      { method: "GET", headers: { authorization: bizAuth } },
      options,
    ),
  )
  const orgs =
    Array.isArray(info?.organizations) ?
      (info!.organizations as Array<unknown>)
    : []

  // 默认机构 + 默认项目（projectType 2 是团队计划，跳过）。
  let org = ""
  let proj = ""
  for (const raw of orgs) {
    const o = asRecord(raw)
    if (!o) continue
    const orgId = asStringOrEmpty(o.organizationId)
    const orgName = asStringOrEmpty(o.organizationName)
    const projects = Array.isArray(o.projects) ? o.projects : []
    let def = ""
    const ids: Array<string> = []
    for (const rawP of projects) {
      const p = asRecord(rawP)
      if (!p) continue
      const pid = asStringOrEmpty(p.projectId)
      if (!pid || String(p.projectType) === "2") continue
      ids.push(pid)
      if (!def && asStringOrEmpty(p.projectName).includes("默认项目")) def = pid
    }
    if (!orgId || ids.length === 0) continue
    if (!def) def = ids[0]!
    if (!org || orgName.includes("默认机构")) {
      org = orgId
      proj = def
      if (orgName.includes("默认机构")) break
    }
  }
  if (!org) {
    throw new HTTPError(
      `This ${site === "bigmodel" ? "BigModel" : "Z.ai"} account has no project for an API key`,
      new Response(null, { status: 502 }),
      "",
    )
  }

  const keysUrl = `${root}/api/biz/v1/organization/${encodeURIComponent(org)}/projects/${encodeURIComponent(proj)}/api_keys`
  const list = await zcodeCall(
    keysUrl,
    { method: "GET", headers: { authorization: bizAuth } },
    options,
  )
  let id = ""
  if (Array.isArray(list)) {
    for (const raw of list) {
      const k = asRecord(raw)
      if (!k) continue
      if (
        asStringOrEmpty(k.name) === "zcode-api-key"
        && asStringOrEmpty(k.apiKey).trim()
      ) {
        id = asStringOrEmpty(k.apiKey).trim()
      }
    }
  }
  if (!id) {
    const made = asRecord(
      await zcodeCall(
        keysUrl,
        {
          method: "POST",
          headers: { authorization: bizAuth },
          body: JSON.stringify({ name: "zcode-api-key" }),
        },
        options,
      ),
    )
    id = asStringOrEmpty(made?.apiKey).trim()
  }
  if (!id) {
    throw new HTTPError(
      `${site === "bigmodel" ? "BigModel" : "Z.ai"} gave no API key`,
      new Response(null, { status: 502 }),
      "",
    )
  }
  const secret = asRecord(
    await zcodeCall(
      `${keysUrl}/copy/${encodeURIComponent(id)}`,
      { method: "GET", headers: { authorization: bizAuth } },
      options,
    ),
  )
  const secretKey = asStringOrEmpty(secret?.secretKey).trim()
  if (!secretKey) {
    throw new HTTPError(
      `${site === "bigmodel" ? "BigModel" : "Z.ai"} gave no API key secret`,
      new Response(null, { status: 502 }),
      "",
    )
  }
  return `${id}.${secretKey}`
}

/** 一次完整登录：轮询 → biz token → 铸 key。 */
export async function zcodeSignInAndMint(
  start: ZcodeSignInStart,
  site: ZcodeSite,
  options?: OAuthFetchOptions & { signal?: AbortSignal },
): Promise<ZcodeKeyBundle> {
  const session = await pollZcodeSignIn(start, site, options)
  const bizAuth = await zcodeBizAuth(site, session.sessionToken, options)
  let apiKey = ""
  try {
    apiKey = await mintZcodeKey(site, bizAuth, options)
  } catch (error) {
    // 纯 Start Plan 账号（只有临时积分、没有 Coding Plan、也没有任何
    // 项目）铸不出 key：只要有 ZCode 会话 JWT，照样能以积分通道登录。
    if (!session.jwt) throw error
  }
  return {
    base: zcodeAnthropicBase(site),
    apiKey,
    site,
    jwt: session.jwt,
    email: session.email,
    userId: session.userId,
  }
}

/** 落库：credential.value = 铸出的 key；base/site/jwt/身份进 context。 */
export function applyZcodeOAuthBundle(
  connection: ProviderConnection,
  bundle: ZcodeKeyBundle,
): void {
  applyOAuthBundleToCredential(
    connection,
    { accessToken: bundle.apiKey },
    { email: bundle.email, accountId: bundle.userId },
  )
  setCredentialContextField(connection, "site", bundle.site)
  setCredentialContextField(connection, "base", bundle.base)
  // ZCode 会话 JWT：Start Plan（临时积分）通道的请求凭证。
  setCredentialContextField(connection, "zcodeJwt", bundle.jwt)
}
