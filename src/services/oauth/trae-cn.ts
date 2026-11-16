/**
 * Trae（trae.cn 中国站 / trae.ai 国际站）的登录与凭证。
 *
 *  - 授权页（www.trae.cn/authorization 或 www.trae.ai/authorization）把浏览器
 *    送回本地回调 `http://127.0.0.1:<port>/authorize`，query 里带 userJwt（token
 *    对，编码后的 JSON）和 userInfo（账号，含该账号的模型 host / region）。
 *  - CN 优先用设备密钥签名的 ExchangeToken 换新 Cloud-IDE-JWT；不支持时退回
 *    旧版交换（会轮换 refresh token）。Global 只有旧版交换。
 *  - 模型请求打到账号自己的模型 host（site.apiOf：消费网关 / 企业 console /
 *    Global 的 US/SG 部署），鉴权与指纹见 services/trae-cn/client.ts。
 *  - deviceId / machineId 在登录时生成一次，授权页与之后的每个请求都带：
 *    开源 relay 实测每次都换新的 device 会被服务端丢请求。
 *  - 企业（SaaS/SSO）登录自 0.2.10 起开放（hide_saas_login=false）：登录命名的
 *    host/authHost 落在 Trae 自己的域上才保留，租户字段只落库展示、不随请求发出。
 */

import { generateKeyPairSync, randomBytes, sign } from "node:crypto"

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  getConnectionProvider,
  getCredentialContextString,
  getMutableProviderConnection,
  persistProviderConnections,
  setCredentialContextField,
} from "~/lib/provider-connections"
import { getConnectionProxyUrl } from "~/lib/provider-connections"
import { asRecordOrEmpty, asTrimmedStringOrEmpty } from "~/lib/json-shape"

import { applyOAuthBundleToCredential } from "~/services/oauth/apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import {
  accountOf,
  authHostOf,
  newTraeDevice,
  TRAE_SITES,
  traeSiteForConnection,
  type TraeDevice,
  type TraeSite,
} from "~/services/trae-cn/sites"

// ── 端点与客户端常量（CN 默认；两站常量在 sites.ts 的 TRAE_SITES） ──────

const CN = TRAE_SITES["trae-cn"]
/** 账号没带模型 host 时的默认模型网关。 */
export const TRAE_CN_API_HOST = CN.hosts.api

/** 本地回调端口：auth_callback_url 写进授权 URL，Trae 接受任意 loopback 端口。 */
export {
  TRAE_CN_CALLBACK_PORT,
  TRAE_CN_CALLBACK_PATH,
} from "~/services/trae-cn/constants"

// ── 小工具 ──────────────────────────────────────────────────────

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

/** 历史名：两站共用的设备指纹。 */
export type TraeCnDevice = TraeDevice

function newTraeCnDeviceKey(): {
  devicePublicKey: string
  devicePrivateKey: string
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  })
  return {
    devicePublicKey: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    devicePrivateKey: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  }
}

/** 新设备（含 P-256 密钥）：CN 16 位、Global 19 位。 */
export function newTraeDeviceFor(site: TraeSite): TraeDevice {
  return { ...newTraeDevice(site), ...newTraeCnDeviceKey() }
}

/** CN 新设备（历史入口）。 */
export function newTraeCnDevice(): TraeDevice {
  return newTraeDeviceFor(CN)
}

// ── 授权 URL ────────────────────────────────────────────────────

/** 授权页 URL：IDE 的 native_ide 登录，回调到本地 /authorize，开放企业 SaaS。 */
export function traeCnSignInUrl(
  callbackUrl: string,
  device: TraeDevice,
  loginTraceId: string,
  site: TraeSite = CN,
): string {
  const q = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: site.pluginVersion,
    auth_type: "local",
    client_id: site.clientId,
    redirect: "0",
    login_trace_id: loginTraceId,
    auth_callback_url: callbackUrl,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_brand: site.brand,
    x_device_type: "windows",
    x_os_version: "Windows 10 Pro",
    x_env: "",
    x_app_version: site.ideVersion,
    x_app_type: "stable",
    // 企业（SaaS/SSO）登录与个人登录并列开放（magpie 0.2.10）。
    hide_saas_login: "false",
  })
  return `${site.hosts.web}/authorization?${q}`
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
  /** 登录命名的模型 host（原始值，仅当形如本站模型 host 时采用）。 */
  api: string
  /** 登录命名的原始 host（企业 console 判定）。 */
  host: string
  /** 登录命名的 token host（已按本站域校验）。 */
  authHost: string
  region: string
  /** 租户/登录类型等展示字段（不随请求发出）。 */
  account: Record<string, string | number | boolean>
  device: TraeDevice
  site: TraeSite
}

/**
 * 解析 combineIntoCode 拼出的回调码：`<userInfo>\u0000<userJwt>`，
 * 两段都是 URL 查询值里的 JSON 文本。Token 缺失但给了 refreshToken
 * （旧版授权页的形状）时现场换一次。
 */
export async function parseTraeCnCallbackCode(
  code: string,
  device: TraeDevice,
  options?: OAuthFetchOptions,
  site: TraeSite = CN,
): Promise<TraeCnSignIn> {
  const [infoRaw = "", jwtRaw = "", extraRaw = "{}"] = code.split("\u0000")
  let extra: Record<string, unknown> = {}
  try {
    extra = asRecordOrEmpty(JSON.parse(extraRaw))
  } catch {
    throw new HTTPError(
      "Trae callback carries malformed query values",
      new Response(null, { status: 400 }),
    )
  }
  if (!jwtRaw && !extra.refreshToken) {
    throw new HTTPError(
      "Trae callback carries no userJwt",
      new Response(null, { status: 400 }),
    )
  }
  const info = asRecordOrEmpty(
    (() => {
      try {
        return JSON.parse(infoRaw || "{}")
      } catch {
        return {}
      }
    })(),
  )
  let jwt: Record<string, unknown> = {}
  try {
    jwt = asRecordOrEmpty(JSON.parse(jwtRaw || "{}"))
  } catch {
    throw new HTTPError(
      "Trae callback carries a malformed userJwt",
      new Response(null, { status: 400 }),
      jwtRaw.slice(0, 200),
    )
  }

  const namedHost =
    asTrimmedStringOrEmpty(extra.host)
    || asTrimmedStringOrEmpty(info.Host)
    || asTrimmedStringOrEmpty(jwt.Host)
  const signIn: TraeCnSignIn = {
    token: asTrimmedStringOrEmpty(jwt.Token ?? jwt.token),
    refresh: asTrimmedStringOrEmpty(
      jwt.RefreshToken ?? jwt.refreshToken ?? extra.refreshToken,
    ),
    expires: traeWhenOf(jwt.TokenExpireAt ?? jwt.tokenExpireAt),
    clientId:
      asTrimmedStringOrEmpty(jwt.ClientID ?? jwt.clientId ?? extra.clientId)
      || site.clientId,
    uid: asTrimmedStringOrEmpty(info.UserID ?? info.userId ?? extra.userId),
    name: asTrimmedStringOrEmpty(info.ScreenName ?? info.screenName),
    api: namedHost,
    host: namedHost,
    authHost: authHostOf(
      extra.authHost ?? extra.auth_host ?? info.AuthHost ?? info.authHost,
      site,
    ),
    region: site.regionOf(info),
    account: accountOf(info),
    device,
    site,
  }
  const authHost = signIn.authHost || site.hosts.auth
  if (!signIn.token && signIn.refresh) {
    const x = await exchangeTraeCnToken(
      signIn.refresh,
      signIn.clientId,
      { ...options, authHost },
      site,
    )
    signIn.token = x.token
    signIn.refresh = x.refresh
    signIn.expires = x.expires
    signIn.clientId = x.clientId || signIn.clientId
    signIn.uid ||= x.uid
    signIn.name ||= x.name
    signIn.api ||= x.api
    signIn.host ||= x.api
    signIn.region ||= x.region
    signIn.account = { ...x.account, ...signIn.account }
  }
  if (!signIn.token) {
    throw new HTTPError(
      `${site.webHost} sent back no token`,
      new Response(null, { status: 400 }),
      jwtRaw.slice(0, 200),
    )
  }
  if (!signIn.refresh) {
    throw new HTTPError(
      `${site.webHost} sent back no refresh token`,
      new Response(null, { status: 400 }),
    )
  }
  if (!signIn.expires) signIn.expires = traeJwtExp(signIn.token)
  // 浏览器回调仍是 IDE 登录；立刻换取绑定这台设备的 JWT（仅 CN 支持）。
  // 绑定不可用时保留有效的回调 token，不额外消耗 refresh token。
  if (site.deviceExchange) {
    try {
      const bound = await exchangeTraeCnDeviceToken(
        signIn.refresh,
        signIn.clientId,
        device,
        { ...options, token: signIn.token, authHost },
        site,
      )
      Object.assign(signIn, {
        token: bound.token,
        refresh: bound.refresh,
        expires: bound.expires || signIn.expires,
        device: bound.device ?? device,
      })
    } catch {
      options?.signal?.throwIfAborted()
      logger.warn(
        `[trae] Device binding unavailable; keeping callback credentials (${site.id})`,
      )
    }
  }
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
  region: string
  account: Record<string, string | number | boolean>
  device?: TraeDevice
}

/** 设备绑定优先（CN）；旧账号首次刷新生成密钥但保留已登录的设备身份。 */
export async function exchangeTraeCnToken(
  refresh: string,
  clientId: string | undefined,
  options?: OAuthFetchOptions & {
    device?: TraeDevice
    token?: string
    authHost?: string
  },
  site: TraeSite = CN,
): Promise<TraeCnTokenExchange> {
  const host = options?.authHost || site.hosts.auth
  const device = options?.device
  if (site.deviceExchange && device?.deviceId && device.machineId) {
    const boundDevice = {
      ...device,
      ...(device.devicePrivateKey && device.devicePublicKey ?
        {}
      : newTraeCnDeviceKey()),
    }
    try {
      return await exchangeTraeCnDeviceToken(
        refresh,
        clientId,
        boundDevice,
        { ...options, authHost: host },
        site,
      )
    } catch {
      options?.signal?.throwIfAborted()
      logger.warn(
        `[trae] Device-bound renewal unavailable; trying legacy exchange (${site.id})`,
      )
    }
    const exchanged = await exchangeLegacyTraeCnToken(
      refresh,
      clientId,
      { ...options, authHost: host },
      site,
    )
    return { ...exchanged, device: boundDevice }
  }
  return exchangeLegacyTraeCnToken(
    refresh,
    clientId,
    { ...options, authHost: host },
    site,
  )
}

async function exchangeTraeCnDeviceToken(
  refresh: string,
  clientId: string | undefined,
  device: TraeDevice,
  options?: OAuthFetchOptions & { token?: string; authHost?: string },
  site: TraeSite = CN,
): Promise<TraeCnTokenExchange> {
  const dx = site.deviceExchange
  if (!dx) {
    throw new Error(`${site.realm} has no device-bound renewal`)
  }
  const boundDevice = {
    ...device,
    ...(device.devicePrivateKey && device.devicePublicKey ?
      {}
    : newTraeCnDeviceKey()),
  }
  const host = (options?.authHost || site.hosts.auth).replace(/\/+$/, "")
  let lastError: unknown
  for (const client of dx.as) {
    options?.signal?.throwIfAborted()
    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = randomBytes(16).toString("hex")
    const proof = [
      "POST",
      dx.path,
      client.clientId,
      refresh,
      String(timestamp),
      nonce,
    ].join("\n")
    try {
      const response = await oauthFetch(
        `${host}${dx.path}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options?.token ?
              { Authorization: `Cloud-IDE-JWT ${options.token}` }
            : {}),
          },
          body: JSON.stringify({
            ClientID: client.clientId,
            ClientSecret: "",
            RefreshToken: refresh,
            IDEVersion: client.version,
            DeviceInfo: {
              DeviceID: boundDevice.deviceId,
              MachineID: boundDevice.machineId,
              PlatformCode: client.platform,
              DeviceType: "PC",
              DeviceName: "",
              DeviceModel: "",
              ClientVersion: client.version,
              DevicePublicKey: boundDevice.devicePublicKey,
              DeviceBrand: site.brand,
              DeviceCPU: "AMD",
              OSInfo: "Windows",
              OSVersion: "10.0.22631",
            },
            DeviceProof: {
              Signature: sign(
                "sha256",
                Buffer.from(proof),
                boundDevice.devicePrivateKey!,
              ).toString("base64"),
              Timestamp: timestamp,
              Nonce: nonce,
            },
          }),
          signal: options?.signal ?? AbortSignal.timeout(20_000),
        },
        options,
      )
      const exchanged = await readTraeCnTokenExchange(
        response,
        refresh,
        clientId,
        site,
      )
      return {
        ...exchanged,
        clientId: clientId || site.clientId,
        device: boundDevice,
      }
    } catch (error) {
      options?.signal?.throwIfAborted()
      lastError = error
    }
  }
  throw lastError
}

/**
 * refresh token → 新 Cloud-IDE-JWT，IDE 的 /cloudide ExchangeToken。
 * Trae 每次签发新的 refresh token，旧的当场作废。
 * 拒收（400/401/403、code 10101、或消息含 refresh/expired/invalid 等）
 * 在消息里带 (401)，让 OAuth 终态判定把账号标成 auth_error 而不是无限重试。
 */
async function exchangeLegacyTraeCnToken(
  refresh: string,
  clientId: string | undefined,
  options?: OAuthFetchOptions & { authHost?: string },
  site: TraeSite = CN,
): Promise<TraeCnTokenExchange> {
  const host = (options?.authHost || site.hosts.auth).replace(/\/+$/, "")
  const response = await oauthFetch(
    `${host}/cloudide/api/v3/trae/oauth/ExchangeToken`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ClientID: clientId || site.clientId,
        RefreshToken: refresh,
        ClientSecret: "-",
        UserID: "",
      }),
      signal: options?.signal ?? AbortSignal.timeout(20_000),
    },
    options,
  )
  return readTraeCnTokenExchange(response, refresh, clientId, site)
}

async function readTraeCnTokenExchange(
  response: Response,
  refresh: string,
  clientId: string | undefined,
  site: TraeSite,
): Promise<TraeCnTokenExchange> {
  const text = await response.text()
  let v: Record<string, unknown> = {}
  try {
    v = asRecordOrEmpty(JSON.parse(text))
  } catch {
    v = {}
  }
  const r = asRecordOrEmpty(v.Result ?? v.result ?? v)
  const token = asTrimmedStringOrEmpty(r.Token ?? r.token)
  if (response.ok && token) {
    const userInfo = r.UserInfo ?? r.userInfo
    const info = asRecordOrEmpty(
      typeof userInfo === "string" ? JSON.parse(userInfo || "{}") : userInfo,
    )
    return {
      token,
      refresh:
        asTrimmedStringOrEmpty(r.RefreshToken ?? r.refreshToken) || refresh,
      expires:
        traeWhenOf(r.TokenExpireAt ?? r.tokenExpireAt) || traeJwtExp(token),
      clientId:
        asTrimmedStringOrEmpty(r.ClientID ?? r.clientId)
        || clientId
        || site.clientId,
      uid: asTrimmedStringOrEmpty(info.UserID ?? info.userId ?? r.UserID),
      name: asTrimmedStringOrEmpty(info.ScreenName ?? info.screenName),
      api: asTrimmedStringOrEmpty(info.Host),
      region: site.regionOf(info),
      account: accountOf(info),
    }
  }
  const e = traeCnErrorOf(text)
  const msg =
    e.message || text.trim().slice(0, 200) || `HTTP ${response.status}`
  const refused =
    [400, 401, 403].includes(response.status)
    || /refresh|expired|revoked|unauthori|not signed|not matched|登录|过期|invalid (token|credential|grant|refresh)/i.test(
      msg,
    )
    || String(e.code) === "10101"
  if (refused) {
    throw new HTTPError(
      `${site.realm}'s sign-in has expired (${msg}); sign in again`,
      new Response(null, { status: 401 }),
      text,
    )
  }
  throw new HTTPError(
    `${site.realm}: renewing the sign-in: HTTP ${response.status} ${msg}`,
    new Response(null, { status: 502 }),
    text,
  )
}

// ── 账号读取（connection → 会话材料） ───────────────────────────

export interface TraeAccount extends TraeDevice {
  site: TraeSite
  token: string
  refresh: string
  clientId: string
  uid: string
  name: string
  /** 解析后的模型 host（消费网关 / 企业 console / Global US/SG）。 */
  apiHost: string
  /** 登录命名的原始模型 host。 */
  api: string
  /** 登录命名的原始 host（企业判定）。 */
  host: string
  /** 解析后的 token host。 */
  authHost: string
  region: string
  account: Record<string, string | number | boolean>
  consoleChat?: boolean
}
/** 历史名。 */
export type TraeCnAccount = TraeAccount

/** 从 connection 的 credential 读会话材料；token 可被刷新后的新值覆盖传入。 */
export function traeCnAccount(
  connection: ProviderConnection,
  token?: string,
): TraeAccount {
  const site = traeSiteForConnection(connection)
  const cred = connection.credentials[0]
  const ctx = cred?.context ?? {}
  const api = asTrimmedStringOrEmpty(
    typeof ctx.apiHost === "string" ? ctx.apiHost : undefined,
  )
  const host = asTrimmedStringOrEmpty(
    typeof ctx.host === "string" ? ctx.host : undefined,
  )
  const region = asTrimmedStringOrEmpty(
    typeof ctx.region === "string" ? ctx.region : undefined,
  )
  const consoleChat = ctx.consoleChat === false ? false : undefined
  const account =
    ctx.accountInfo && typeof ctx.accountInfo === "string" ?
      (asRecordOrEmpty(
        (() => {
          try {
            return JSON.parse(ctx.accountInfo)
          } catch {
            return {}
          }
        })(),
      ) as Record<string, string | number | boolean>)
    : {}
  const hostCtx = { api, host, region, consoleChat }
  return {
    site,
    token: token ?? cred?.value ?? "",
    refresh: getCredentialContextString(connection, "refreshToken") ?? "",
    clientId:
      getCredentialContextString(connection, "clientId") || site.clientId,
    uid: getCredentialContextString(connection, "oauthAccountId") ?? "",
    name:
      getCredentialContextString(connection, "email")
      ?? getCredentialContextString(connection, "oauthAccountId")
      ?? "",
    deviceId: getCredentialContextString(connection, "deviceId") ?? "",
    machineId: getCredentialContextString(connection, "machineId") ?? "",
    devicePublicKey: getCredentialContextString(connection, "devicePublicKey"),
    devicePrivateKey: getCredentialContextString(
      connection,
      "devicePrivateKey",
    ),
    api,
    host,
    region,
    account,
    consoleChat,
    authHost:
      authHostOf(getCredentialContextString(connection, "authHost"), site)
      || site.hosts.auth,
    apiHost: site.apiOf(hostCtx),
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
          return asRecordOrEmpty(JSON.parse(raw))
        } catch {
          return {}
        }
      })()
    : asRecordOrEmpty(raw)
  const meta = asRecordOrEmpty(asRecordOrEmpty(v.ResponseMetadata).Error)
  if (meta.Code || meta.Message) {
    return {
      code: (meta.Code as string | number) ?? "",
      message: String(meta.Message ?? meta.Code ?? ""),
    }
  }
  const e = asRecordOrEmpty(v.error).code ? asRecordOrEmpty(v.error) : v
  const code = (e.code ?? e.Code ?? v.code ?? "") as string | number
  const message =
    e.message
    ?? e.msg
    ?? e.Message
    ?? (typeof v.error === "string" ? v.error : "")
    ?? ""
  return { code, message: String(message) }
}

/** Trae 拒收 token 的判定：按站点的 lapsed 码（CN 1001/401，Global 加 20101）。 */
export function traeCnLapsed(
  code: unknown,
  message: string,
  site: TraeSite = CN,
): boolean {
  return (
    site.lapsed.includes(code as number | string)
    || /not ?log(ged)? ?in|unauthori[sz]ed|token (is )?(expired|invalid)|jwt|未登录|登录(已)?(过期|失效)/i.test(
      message,
    )
  )
}

/** 配额/积分耗尽：按站点的 quota 码（Global 加 4011），或消息里的额度字样。 */
export function traeCnQuotaError(
  code: unknown,
  message: string,
  site: TraeSite = CN,
): boolean {
  return (
    site.quota.includes(code as number | string)
    || /quota|credit|insufficient|exceed|limit|额度|积分|次数|上限|用完/i.test(
      message,
    )
  )
}

/** 这个 chat function 不认该模型/请求：换下一个 function 试。 */
export function traeCnWrongFunction(code: unknown): boolean {
  return ["4001", "4023", "1005"].includes(String(code))
}

/** 企业 console 拒收 chat（4245）：回退消费网关再试一次。 */
export function traeCnConsoleRefuses(code: unknown): boolean {
  return String(code) === "4245"
}

// ── 落库 ────────────────────────────────────────────────────────

/**
 * sign-in 结果落到 connection：
 * - credential.value = Cloud-IDE-JWT；context 带 refresh/expires；
 * - Trae 专属材料（clientId/deviceId/machineId/apiHost/host/authHost/region/
 *   accountInfo/uid/screenName）进 credential.context。
 */
export function applyTraeCnOAuthBundle(
  connection: ProviderConnection,
  signIn: Omit<
    TraeCnSignIn,
    "device" | "site" | "host" | "authHost" | "region" | "account"
  > & {
    device?: TraeDevice
    site?: TraeSite
    consoleChat?: boolean
    host?: string
    authHost?: string
    region?: string
    account?: Record<string, string | number | boolean>
  },
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
  for (const key of ["devicePublicKey", "devicePrivateKey"] as const) {
    if (signIn.device?.[key]) {
      setCredentialContextField(connection, key, signIn.device[key])
    }
  }
  if (signIn.api) {
    setCredentialContextField(connection, "apiHost", signIn.api)
  }
  if (signIn.host) {
    setCredentialContextField(connection, "host", signIn.host)
  }
  if (signIn.authHost) {
    setCredentialContextField(connection, "authHost", signIn.authHost)
  }
  if (signIn.region) {
    setCredentialContextField(connection, "region", signIn.region)
  }
  if (signIn.account && Object.keys(signIn.account).length) {
    setCredentialContextField(
      connection,
      "accountInfo",
      JSON.stringify(signIn.account),
    )
  }
  const cred = connection.credentials[0]!
  if (cred) {
    if (!cred.context) cred.context = {}
    if (signIn.consoleChat === false) cred.context.consoleChat = false
    else delete cred.context.consoleChat
  }
}

/** 刷新后的 token 对回填（prepareOAuthRefresh 在 connection 副本上调用）。 */
export function applyTraeCnTokenBundle(
  connection: ProviderConnection,
  exchange: TraeCnTokenExchange,
): void {
  const site = traeSiteForConnection(connection)
  // 刷新可能带回新的 region/account/host；保留已落库的企业 consoleChat 标记。
  const existing = traeCnAccount(connection)
  applyTraeCnOAuthBundle(connection, {
    token: exchange.token,
    refresh: exchange.refresh,
    expires: exchange.expires,
    clientId: exchange.clientId,
    uid: exchange.uid,
    name: exchange.name,
    api: exchange.api || existing.api,
    host: existing.host,
    authHost: existing.authHost === site.hosts.auth ? "" : existing.authHost,
    region: exchange.region || existing.region,
    account:
      Object.keys(exchange.account).length ?
        exchange.account
      : existing.account,
    device: exchange.device,
    site,
    consoleChat: existing.consoleChat,
  })
}

/** 要求该 connection 是 Trae 账号（CN 或 Global）；不是则抛错。 */
export function requireTraeCnProvider(connection: ProviderConnection): void {
  const provider = getConnectionProvider(connection)
  if (provider !== "trae-cn" && provider !== "trae-global") {
    throw new Error("requires a Trae connection")
  }
}

/**
 * 企业 console 拒收 chat（4245）：标记该账号 consoleChat=false，之后模型
 * 请求回退消费网关（site.apiOf 据此选 host）。落 live connection 的 context。
 */
export async function markTraeCnConsoleRefused(
  connection: ProviderConnection,
): Promise<void> {
  const live = getMutableProviderConnection(connection.id) ?? connection
  const active = live.credentials.at(0)
  const sent = connection.credentials.at(0)
  if (!active || !sent || active.id !== sent.id || active.value !== sent.value)
    return
  active.context ??= {}
  active.context.consoleChat = false
  sent.context ??= {}
  sent.context.consoleChat = false
  if (live !== connection || getMutableProviderConnection(connection.id)) {
    await persistProviderConnections()
  }
}
