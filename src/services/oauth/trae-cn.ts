/**
 * Trae CN（trae.cn，字节跳动 AI IDE）的登录与凭证。
 *
 *  - trae.cn 的授权页（www.trae.cn/authorization）把浏览器送回本地回调
 *    `http://127.0.0.1:<port>/authorize`，query 里带 userJwt（token 对，
 *    编码后的 JSON）和 userInfo（账号，含该账号的模型 host）。
 *  - refresh token 在 api.trae.cn 的 ExchangeToken 换新 Cloud-IDE-JWT；
 *    每次换新签发新的 refresh token，旧的即作废（不可重放）。
 *  - 模型请求打到账号自己的模型 host（默认 trae-api-cn.mchost.guru），
 *    鉴权与指纹见 services/trae-cn/client.ts 的 ideHeaders。
 *  - deviceId / machineId 在登录时生成一次，授权页与之后的每个请求都带：
 *    开源 relay 实测每次都换新的 device 会被服务端丢请求。
 */

import { randomBytes, randomInt } from "node:crypto"

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import {
  getConnectionProvider,
  getCredentialContextString,
  setCredentialContextField,
} from "~/lib/provider-connections"
import { getConnectionProxyUrl } from "~/lib/provider-connections"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"

// ── 端点与客户端常量 ────────────────────────────────────────────

const TRAE_CN_WEB_HOST = "https://www.trae.cn"
export const TRAE_CN_AUTH_HOST = "https://api.trae.cn"
/** 账号没带模型 host 时的默认模型网关。 */
export const TRAE_CN_API_HOST = "https://trae-api-cn.mchost.guru"

const TRAE_CN_CLIENT_ID = "ono9krqynydwx5" // Trae CN 的 IDE
export const TRAE_CN_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8"
const TRAE_CN_IDE_VERSION = "3.3.65"
const TRAE_CN_PLUGIN_VERSION = "2.3.24254"
// 对模型网关自称的客户端：TRAE SOLO CN 0.1.69。Trae 只给足够新的
// 客户端开放新模型（2026-04 的 IDE 拿不到 deepseek-v4.1-flash）。
export const TRAE_CN_CLIENT_VERSION = "0.1.69"
export const TRAE_CN_CLIENT_VERSION_CODE = "20260917"
const TRAE_CN_DEVICE_BRAND = "ASUS TUF Gaming A15 FA507RM_FA507RM"

/** 本地回调端口：auth_callback_url 写进授权 URL，Trae 接受任意 loopback 端口。 */
export {
  TRAE_CN_CALLBACK_PORT,
  TRAE_CN_CALLBACK_PATH,
} from "~/services/trae-cn/constants"

// ── 小工具 ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function asStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Trae 的到期时间：秒、毫秒或 ISO 字符串，统一为毫秒；读不出为 0。 */
export function traeWhenOf(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    const t = Date.parse(value)
    return Number.isNaN(t) ? 0 : t
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e11 ? n * 1000 : n
}

/** JWT 的 exp（毫秒），无 exp 为 0。 */
function traeJwtExp(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString(),
    ) as { exp?: number }
    return traeWhenOf(payload.exp)
  } catch {
    return 0
  }
}

// ── 设备指纹 ────────────────────────────────────────────────────

export interface TraeCnDevice {
  /** 19 位数字串。 */
  deviceId: string
  /** 16 字节 hex。 */
  machineId: string
}

export function newTraeCnDevice(): TraeCnDevice {
  const digits = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      i === 0 ? randomInt(1, 10) : randomInt(0, 10),
    ).join("")
  return {
    deviceId: digits(19),
    machineId: randomBytes(16).toString("hex"),
  }
}

// ── 授权 URL ────────────────────────────────────────────────────

/** trae.cn 的授权页 URL：IDE 的 native_ide 登录，回调到本地 /authorize。 */
export function traeCnSignInUrl(
  callbackUrl: string,
  device: TraeCnDevice,
  loginTraceId: string,
): string {
  const q = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: TRAE_CN_PLUGIN_VERSION,
    auth_type: "local",
    client_id: TRAE_CN_CLIENT_ID,
    redirect: "0",
    login_trace_id: loginTraceId,
    auth_callback_url: callbackUrl,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_brand: TRAE_CN_DEVICE_BRAND,
    x_device_type: "windows",
    x_os_version: "Windows 10 Pro",
    x_env: "",
    x_app_version: TRAE_CN_IDE_VERSION,
    x_app_type: "stable",
    hide_saas_login: "true",
  })
  return `${TRAE_CN_WEB_HOST}/authorization?${q}`
}

// ── 登录结果 ────────────────────────────────────────────────────

interface TraeCnSignIn {
  /** Cloud-IDE-JWT。 */
  token: string
  refresh: string
  /** JWT 到期（毫秒）。 */
  expires: number
  clientId: string
  uid: string
  name: string
  /** 该账号的模型 host（userJwt/userInfo 的 host，仅当形如模型网关时）。 */
  api: string
  device: TraeCnDevice
}

/**
 * 解析 combineIntoCode 拼出的回调码：`<userInfo>\u0000<userJwt>`，
 * 两段都是 URL 查询值里的 JSON 文本。Token 缺失但给了 refreshToken
 * （旧版授权页的形状）时现场换一次。
 */
export async function parseTraeCnCallbackCode(
  code: string,
  device: TraeCnDevice,
  options?: OAuthFetchOptions,
): Promise<TraeCnSignIn> {
  const [infoRaw = "", jwtRaw = ""] = code.split("\u0000")
  if (!jwtRaw) {
    throw new HTTPError(
      "Trae CN callback carries no userJwt",
      new Response(null, { status: 400 }),
    )
  }
  let info: Record<string, unknown> = {}
  let jwt: Record<string, unknown> = {}
  try {
    info = asRecord(JSON.parse(infoRaw || "{}"))
  } catch {
    /* userInfo 可能缺失 */
  }
  try {
    jwt = asRecord(JSON.parse(jwtRaw))
  } catch {
    throw new HTTPError(
      "Trae CN callback carries a malformed userJwt",
      new Response(null, { status: 400 }),
      jwtRaw.slice(0, 200),
    )
  }

  const signIn: TraeCnSignIn = {
    token: asStr(jwt.Token ?? jwt.token),
    refresh: asStr(jwt.RefreshToken ?? jwt.refreshToken),
    expires: traeWhenOf(jwt.TokenExpireAt ?? jwt.tokenExpireAt),
    clientId: asStr(jwt.ClientID ?? jwt.clientId) || TRAE_CN_CLIENT_ID,
    uid: asStr(info.UserID ?? info.userId),
    name: asStr(info.ScreenName ?? info.screenName),
    api: asStr(info.Host) || asStr(jwt.Host),
    device,
  }
  if (!signIn.token && signIn.refresh) {
    const x = await exchangeTraeCnToken(
      signIn.refresh,
      signIn.clientId,
      options,
    )
    signIn.token = x.token
    signIn.refresh = x.refresh
    signIn.expires = x.expires
    signIn.clientId = x.clientId || signIn.clientId
    signIn.uid ||= x.uid
    signIn.name ||= x.name
    signIn.api ||= x.api
  }
  if (!signIn.token) {
    throw new HTTPError(
      "trae.cn sent back no token",
      new Response(null, { status: 400 }),
      jwtRaw.slice(0, 200),
    )
  }
  if (!signIn.refresh) {
    throw new HTTPError(
      "trae.cn sent back no refresh token",
      new Response(null, { status: 400 }),
    )
  }
  if (!signIn.expires) signIn.expires = traeJwtExp(signIn.token)
  return signIn
}

// ── token 交换（刷新） ──────────────────────────────────────────

interface TraeCnTokenExchange {
  token: string
  refresh: string
  expires: number
  clientId: string
  uid: string
  name: string
  api: string
}

/**
 * refresh token → 新 Cloud-IDE-JWT，IDE 的 ExchangeToken。
 * Trae 每次签发新的 refresh token，旧的当场作废。
 * 拒收（400/401/403、code 10101、或消息含 refresh/expired/invalid 等）
 * 在消息里带 (401)，让 OAuth 终态判定把账号标成 auth_error 而不是无限重试。
 */
export async function exchangeTraeCnToken(
  refresh: string,
  clientId: string | undefined,
  options?: OAuthFetchOptions,
): Promise<TraeCnTokenExchange> {
  const response = await oauthFetch(
    `${TRAE_CN_AUTH_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ClientID: clientId || TRAE_CN_CLIENT_ID,
        RefreshToken: refresh,
        ClientSecret: "-",
        UserID: "",
      }),
      signal: options?.signal ?? AbortSignal.timeout(20_000),
    },
    options,
  )
  const text = await response.text()
  let v: Record<string, unknown> = {}
  try {
    v = asRecord(JSON.parse(text))
  } catch {
    v = {}
  }
  const r = asRecord(v.Result ?? v.result ?? v)
  const token = asStr(r.Token ?? r.token)
  if (response.ok && token) {
    const info = asRecord(JSON.parse(asStr(r.UserInfo ?? r.userInfo) || "{}"))
    return {
      token,
      refresh: asStr(r.RefreshToken ?? r.refreshToken) || refresh,
      expires:
        traeWhenOf(r.TokenExpireAt ?? r.tokenExpireAt) || traeJwtExp(token),
      clientId:
        asStr(r.ClientID ?? r.clientId) || clientId || TRAE_CN_CLIENT_ID,
      uid: asStr(info.UserID ?? info.userId ?? r.UserID),
      name: asStr(info.ScreenName ?? info.screenName),
      api: asStr(info.Host),
    }
  }
  const e = traeCnErrorOf(text)
  const msg =
    e.message || text.trim().slice(0, 200) || `HTTP ${response.status}`
  const refused =
    [400, 401, 403].includes(response.status)
    || /refresh|expired|revoked|unauthori|not signed|登录|过期|invalid (token|credential|grant|refresh)/i.test(
      msg,
    )
    || String(e.code) === "10101"
  if (refused) {
    throw new HTTPError(
      `Trae CN's sign-in has expired (${msg}); sign in again`,
      new Response(null, { status: 401 }),
      text,
    )
  }
  throw new HTTPError(
    `Trae CN: renewing the sign-in: HTTP ${response.status} ${msg}`,
    new Response(null, { status: 502 }),
    text,
  )
}

// ── 账号读取（connection → 会话材料） ───────────────────────────

export interface TraeCnAccount {
  token: string
  refresh: string
  clientId: string
  uid: string
  name: string
  deviceId: string
  machineId: string
  /** 该账号的模型 host。 */
  apiHost: string
}

function traeCnApiHost(api: string | undefined): string {
  const h = (api ?? "").replace(/\/+$/, "")
  return /mchost\.guru|trae-api-/i.test(h) ? h : TRAE_CN_API_HOST
}

/** 从 connection 的 credential 读会话材料；token 可被刷新后的新值覆盖传入。 */
export function traeCnAccount(
  connection: ProviderConnection,
  token?: string,
): TraeCnAccount {
  const cred = connection.credentials[0]
  const ctx = cred?.context ?? {}
  return {
    token: token ?? cred?.value ?? "",
    refresh: getCredentialContextString(connection, "refreshToken") ?? "",
    clientId:
      getCredentialContextString(connection, "clientId") || TRAE_CN_CLIENT_ID,
    uid: getCredentialContextString(connection, "oauthAccountId") ?? "",
    name:
      getCredentialContextString(connection, "email")
      ?? getCredentialContextString(connection, "oauthAccountId")
      ?? "",
    deviceId: getCredentialContextString(connection, "deviceId") ?? "",
    machineId: getCredentialContextString(connection, "machineId") ?? "",
    apiHost: traeCnApiHost(
      typeof ctx.apiHost === "string" ? ctx.apiHost : undefined,
    ),
  }
}

/** connection 的代理（flow 里的 proxyUrl 落到 settings 后由它读出）。 */
export function traeCnProxyUrl(
  connection: ProviderConnection,
): string | undefined {
  return getConnectionProxyUrl(connection)
}

/** Trae 的错误形状：{code,message} / {error:{...}} / ByteDance ResponseMetadata。 */
export function traeCnErrorOf(raw: unknown): {
  code: string | number
  message: string
} {
  const v =
    typeof raw === "string" ?
      ((): Record<string, unknown> => {
        try {
          return asRecord(JSON.parse(raw))
        } catch {
          return {}
        }
      })()
    : asRecord(raw)
  const meta = asRecord(asRecord(v.ResponseMetadata).Error)
  if (meta.Code || meta.Message) {
    return {
      code: (meta.Code as string | number) ?? "",
      message: String(meta.Message ?? meta.Code ?? ""),
    }
  }
  const e = asRecord(v.error).code ? asRecord(v.error) : v
  const code = (e.code ?? e.Code ?? v.code ?? "") as string | number
  const message =
    e.message
    ?? e.msg
    ?? e.Message
    ?? (typeof v.error === "string" ? v.error : "")
    ?? ""
  return { code, message: String(message) }
}

/** Trae 拒收 token 的判定：1001 not signed in，401，或消息里的登录失效字样。 */
export function traeCnLapsed(code: unknown, message: string): boolean {
  return (
    [1001, "1001", 401, "401"].includes(code as number | string)
    || /not ?log(ged)? ?in|unauthori[sz]ed|token (is )?(expired|invalid)|jwt|未登录|登录(已)?(过期|失效)/i.test(
      message,
    )
  )
}

/** 配额/积分耗尽：4008、1005，或消息里的额度字样。 */
export function traeCnQuotaError(code: unknown, message: string): boolean {
  return (
    [4008, "4008", 1005, "1005"].includes(code as number | string)
    || /quota|credit|insufficient|exceed|limit|额度|积分|次数|上限|用完/i.test(
      message,
    )
  )
}

/** 这个 chat function 不认该模型/请求：换下一个 function 试。 */
export function traeCnWrongFunction(code: unknown): boolean {
  return ["4001", "4023", "1005"].includes(String(code))
}

// ── 落库 ────────────────────────────────────────────────────────

/**
 * sign-in 结果落到 connection：
 * - credential.value = Cloud-IDE-JWT；context 带 refresh/expires；
 * - Trae 专属材料（clientId/deviceId/machineId/apiHost/uid/screenName）
 *   进 credential.context 与 metadata.credentialExtras。
 */
export function applyTraeCnOAuthBundle(
  connection: ProviderConnection,
  signIn: Omit<TraeCnSignIn, "device"> & { device?: TraeCnDevice },
): void {
  applyOAuthBundleToCredential(
    connection,
    {
      accessToken: signIn.token,
      refreshToken: signIn.refresh,
      expiresAt: signIn.expires || undefined,
    },
    {
      email: signIn.name || undefined,
      accountId: signIn.uid || undefined,
      deviceId: signIn.device?.deviceId,
    },
  )
  setCredentialContextField(connection, "clientId", signIn.clientId)
  if (signIn.device?.machineId) {
    setCredentialContextField(connection, "machineId", signIn.device.machineId)
  }
  if (signIn.api) {
    setCredentialContextField(connection, "apiHost", signIn.api)
  }
}

/** 刷新后的 token 对回填（prepareOAuthRefresh 在 connection 副本上调用）。 */
export function applyTraeCnTokenBundle(
  connection: ProviderConnection,
  exchange: TraeCnTokenExchange,
): void {
  applyTraeCnOAuthBundle(connection, {
    token: exchange.token,
    refresh: exchange.refresh,
    expires: exchange.expires,
    clientId: exchange.clientId,
    uid: exchange.uid,
    name: exchange.name,
    api: exchange.api,
  })
}

/** 要求该 connection 是 trae-cn 账号；不是则抛错（fetcher/adapter 的入口断言）。 */
export function requireTraeCnProvider(connection: ProviderConnection): void {
  if (getConnectionProvider(connection) !== "trae-cn") {
    throw new Error("requires a Trae CN connection")
  }
}
