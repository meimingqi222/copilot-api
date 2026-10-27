/**
 * ZCode 的阿里云无痕验证（traceless）求解。
 *
 * 领取限时套餐必须带 `X-Aliyun-Captcha-Verify-Param`，这个值只能由官方
 * SDK 在真浏览器里跑出来（见 browser.ts 的说明）。做法与 zcode2api /
 * zcode-switch 同形：
 *
 *   1. `GET /api/v1/client/configs?app_version=` 拿 sceneId / prefix / region
 *      （免鉴权，缓存 10 分钟；拿不到用内置默认值）；
 *   2. 起 headless Chrome，开一个本地页面，注入 AliyunCaptcha.js；
 *   3. `initAliyunCaptcha` → `startTracelessVerification()` → success 回调
 *      给出 verifyParam（真环境自动过，无滑块）；
 *   4. 结果缓存 ~90s（上游 token 实际 TTL 约 2 分钟），并发共用同一次求解。
 *
 * 失败一律抛 ZcodeCaptchaError：调用方把它折成可读文案（WebUI 会展示
 * 浏览器安装/求解失败的原因）。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProxyUrl } from "~/lib/provider-connections"
import { logger } from "~/lib/logger"
import { asRecord } from "~/lib/json-shape"
import { oauthFetch } from "~/services/oauth/fetch"
import { ZCODE_API, ZCODE_APP_VERSION } from "~/services/oauth/zcode"

import { ensureZcodeBrowser, __resetZcodeBrowserForTest } from "./browser"
import { evaluatePage, launchChrome } from "./cdp"

interface ZcodeCaptchaConfig {
  sceneId: string
  prefix: string
  region: string
  enabled: boolean
}

/** client/configs 拿不到时的兜底（与官方现网一致）。 */
const DEFAULT_CONFIG: ZcodeCaptchaConfig = {
  sceneId: "11xygtvd",
  prefix: "no8xfe",
  region: "cn",
  enabled: true,
}

const CONFIG_TTL_MS = 10 * 60 * 1000
/** 上游 verifyParam 实际约 2 分钟过期，留出余量。 */
const TOKEN_TTL_MS = 90 * 1000
const SOLVE_ATTEMPTS = 3

class ZcodeCaptchaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ZcodeCaptchaError"
  }
}

const CAPTCHA_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>captcha</title></head>
<body><div id="cap-holder"></div><button id="cap-btn">verify</button></body></html>
`

const HIDE_WEBDRIVER = `
Object.defineProperty(navigator, "webdriver", { get: () => undefined });
Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
Object.defineProperty(navigator, "platform", { get: () => "Win32" });
`

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"

let cachedConfig: ZcodeCaptchaConfig | undefined
let cachedConfigAt = 0
let configTask: Promise<ZcodeCaptchaConfig> | undefined

let cachedToken:
  | { param: string; region: string; sceneId: string; at: number }
  | undefined
let tokenTask: Promise<{ param: string; region: string }> | undefined
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** 解析 client/configs 的 captcha 段（camelCase / snake_case 都接受）。 */
function parseZcodeCaptchaConfig(raw: unknown): ZcodeCaptchaConfig {
  const captcha = asRecord(raw)
  if (!captcha) return { ...DEFAULT_CONFIG }
  const sceneId =
    str(captcha.sceneId) || str(captcha.scene_id) || DEFAULT_CONFIG.sceneId
  const prefix =
    str(captcha.prefix) || str(captcha.prefix_id) || DEFAULT_CONFIG.prefix
  const region =
    str(captcha.region) || str(captcha.region_id) || DEFAULT_CONFIG.region
  return {
    sceneId,
    prefix,
    region,
    enabled: captcha.enabled === false ? false : true,
  }
}

/** 拉取验证码配置（带缓存；失败回退默认值，不让求解整体失败）。 */
async function fetchZcodeCaptchaConfig(
  connection?: ProviderConnection,
  signal?: AbortSignal,
): Promise<ZcodeCaptchaConfig> {
  if (cachedConfig && Date.now() - cachedConfigAt < CONFIG_TTL_MS) {
    return cachedConfig
  }
  if (configTask) return configTask
  const proxyUrl = connection ? getConnectionProxyUrl(connection) : undefined
  const task = (async () => {
    try {
      const response = await oauthFetch(
        `${ZCODE_API}/api/v1/client/configs?app_version=${encodeURIComponent(ZCODE_APP_VERSION)}`,
        {
          headers: { accept: "application/json" },
          ...(signal ? { signal } : {}),
        },
        proxyUrl ? { proxyUrl } : undefined,
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as Record<string, unknown>
      const configs = asRecord(asRecord(body.data)?.configs)
      const config = parseZcodeCaptchaConfig(configs?.captcha)
      cachedConfig = config
      cachedConfigAt = Date.now()
      return config
    } catch (error) {
      logger.warn(
        `Could not read ZCode captcha config, using defaults: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return { ...DEFAULT_CONFIG }
    }
  })().finally(() => {
    configTask = undefined
  })
  configTask = task
  return task
}

function solverExpression(config: ZcodeCaptchaConfig): string {
  return `(async () => {
    const scene = ${JSON.stringify(config.sceneId)};
    const region = ${JSON.stringify(config.region)};
    const prefix = ${JSON.stringify(config.prefix)};
    if (typeof window.initAliyunCaptcha !== "function") {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
        script.onload = () => resolve(true);
        script.onerror = () => reject(new Error("AliyunCaptcha SDK failed to load"));
        document.head.appendChild(script);
      });
    }
    window.AliyunCaptchaConfig = { region, prefix };
    return await new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value || null); } };
      try {
        window.initAliyunCaptcha({
          SceneId: scene,
          mode: "popup",
          language: "zh-CN",
          showErrorTip: false,
          element: "#cap-holder",
          button: "#cap-btn",
          getInstance: (instance) => {
            try { instance.startTracelessVerification(); }
            catch { finish(null); }
          },
          success: (payload) => {
            const value = typeof payload === "string" ? payload : payload && payload.captchaVerifyParam;
            finish(value);
          },
          fail: () => finish(null),
          onError: () => finish(null),
        });
      } catch { finish(null); }
      setTimeout(() => finish(null), 25000);
    });
  })()`
}

async function solveOnce(
  config: ZcodeCaptchaConfig,
  proxyUrl: string | undefined,
): Promise<string | undefined> {
  const executablePath = await ensureZcodeBrowser()
  const pageFile = path.join(
    os.tmpdir(),
    `zcode-captcha-${crypto.randomUUID()}.html`,
  )
  fs.writeFileSync(pageFile, CAPTCHA_PAGE, { mode: 0o600 })
  const browser = await launchChrome({
    executablePath,
    args: proxyUrl ? [`--proxy-server=${proxyUrl}`] : [],
  })
  try {
    const sessionId = await browser.newPage()
    await browser.send("Page.enable", {}, sessionId)
    await browser.send("Runtime.enable", {}, sessionId)
    await browser.send(
      "Network.setUserAgentOverride",
      {
        userAgent: USER_AGENT,
        acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
        platform: "Win32",
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: "127" },
            { brand: "Google Chrome", version: "127" },
          ],
          fullVersionList: [
            { brand: "Chromium", version: "127.0.0.0" },
            { brand: "Google Chrome", version: "127.0.0.0" },
          ],
          platform: "Windows",
          platformVersion: "10.0.0",
          architecture: "x86",
          model: "",
          mobile: false,
          bitness: "64",
          wow64: false,
        },
      },
      sessionId,
    )
    await browser.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: HIDE_WEBDRIVER },
      sessionId,
    )
    await browser.send(
      "Page.navigate",
      { url: `file://${pageFile}` },
      sessionId,
    )

    // 文件页几乎瞬时完成；轮询 readyState 避免在旧执行上下文里求值。
    for (let i = 0; i < 50; i++) {
      const state = await evaluatePage(browser, "document.readyState", {
        sessionId,
      })
      if (state === "complete") break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const value = await evaluatePage(browser, solverExpression(config), {
      sessionId,
      awaitPromise: true,
      timeoutMs: 45_000,
    })
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  } finally {
    await browser.close()
    try {
      fs.rmSync(pageFile, { force: true })
    } catch {
      /* best effort */
    }
  }
}

/**
 * 求一枚 verifyParam。默认带重试（真浏览器启动 + SDK 加载偶发失败，
 * 每次都换一个新进程）。
 */
async function solveZcodeVerifyParam(options?: {
  connection?: ProviderConnection
  signal?: AbortSignal
}): Promise<{ param: string; region: string }> {
  options?.signal?.throwIfAborted()
  const config = await fetchZcodeCaptchaConfig(
    options?.connection,
    options?.signal,
  )
  const proxyUrl =
    options?.connection ? getConnectionProxyUrl(options.connection) : undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= SOLVE_ATTEMPTS; attempt++) {
    options?.signal?.throwIfAborted()
    try {
      const param = await solveOnce(config, proxyUrl)
      if (param) {
        logger.info(`ZCode captcha solved (attempt ${attempt})`)
        return { param, region: config.region }
      }
      lastError = new Error("the page produced no verifyParam")
    } catch (error) {
      lastError = error
      logger.warn(
        `ZCode captcha attempt ${attempt}/${SOLVE_ATTEMPTS} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (attempt < SOLVE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  throw new ZcodeCaptchaError(
    `Captcha solving failed: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

/**
 * 取一枚可用的 verifyParam：优先缓存（90s 内），并发共享同一次求解。
 */
export async function getZcodeVerifyParam(options?: {
  connection?: ProviderConnection
  signal?: AbortSignal
}): Promise<{ param: string; region: string }> {
  const now = Date.now()
  if (
    cachedToken
    && now - cachedToken.at < TOKEN_TTL_MS
    && cachedToken.sceneId === (cachedConfig?.sceneId ?? cachedToken.sceneId)
  ) {
    return { param: cachedToken.param, region: cachedToken.region }
  }
  if (tokenTask) return tokenTask
  const task = solveZcodeVerifyParam(options)
    .then((token) => {
      cachedToken = {
        ...token,
        sceneId: cachedConfig?.sceneId ?? DEFAULT_CONFIG.sceneId,
        at: Date.now(),
      }
      return token
    })
    .finally(() => {
      tokenTask = undefined
    })
  tokenTask = task
  return task
}

/** 上游返回 3007（验证码被拒）时丢掉这枚 token，下一轮重新解。 */
export function invalidateZcodeVerifyParam(): void {
  cachedToken = undefined
}

/** 测试用：注入一枚现成 token，避免测试里真的起浏览器。 */
export function __setZcodeVerifyParamForTest(
  param: string,
  region = DEFAULT_CONFIG.region,
  sceneId = DEFAULT_CONFIG.sceneId,
): void {
  cachedToken = { param, region, sceneId, at: Date.now() }
}

/** 测试用。 */
export function __resetZcodeCaptchaForTest(): void {
  cachedConfig = undefined
  cachedConfigAt = 0
  configTask = undefined
  cachedToken = undefined
  tokenTask = undefined
  __resetZcodeBrowserForTest()
}
