/**
 * ZCode 验证码求解要的真浏览器：定位一个 Chromium，没有就下载安装。
 *
 * 为什么必须是真浏览器：阿里云无痕验证（traceless）自 2026-09 起会拒掉
 * 模拟 DOM 造出来的 token（上游按 bot 判「unusual activity」），所以
 * 求解器只能在真 Chrome/Chromium 里跑官方 SDK。这里只管「拿到一个可执行
 * 文件」，驱动部分在 cdp.ts。
 *
 * 定位顺序：
 *   1. 环境变量 ZCODE_CHROMIUM_PATH / CHROME_PATH / PUPPETEER_EXECUTABLE_PATH；
 *   2. 上次下载安装记录的路径（数据目录 zcode-browser.json）；
 *   3. 系统常见路径（Linux / macOS / Windows）。
 * 都没有时用 @puppeteer/browsers 下载 Chrome for Testing 到数据目录
 * （流式解压，不把 150MB 压缩包读进内存）。
 *
 * 安装状态存在进程内，`zcodeBrowserStatus()` 给 WebUI 轮询：下载进度、
 * 失败原因都从这里读。Alpine/musl 镜像跑不了 Chrome，安装前直接给出
 * 可读的失败原因，避免白下 150MB。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  Browser,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} from "@puppeteer/browsers"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"

type ZcodeBrowserState = "ready" | "missing" | "installing" | "error"

interface ZcodeBrowserStatus {
  state: ZcodeBrowserState
  /** 可执行文件绝对路径（ready 时给出）。 */
  path?: string
  source?: "env" | "system" | "managed"
  version?: string
  /** 失败原因/进度文案，直接展示给用户。 */
  message?: string
  updatedAt: number
  /** 下载进度（installing 时给出）。 */
  download?: { downloaded: number; total: number }
}

const RECORD_FILE = "zcode-browser.json"
const CACHE_DIR = "zcode-browsers"

let status: ZcodeBrowserStatus = { state: "missing", updatedAt: Date.now() }
let installTask: Promise<string> | undefined

class ZcodeBrowserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ZcodeBrowserError"
  }
}

function setStatus(patch: Partial<ZcodeBrowserStatus>): void {
  status = { ...status, ...patch, updatedAt: Date.now() }
}

/**
 * WebUI 读的浏览器状态。
 *
 * 进程刚起来时状态还是 missing，所以要顺手做一次定位：已经装过（记录文件）
 * 或系统里本来就有 Chromium 时直接报 ready，而不是等第一次求解才显示。
 * 安装进行中不打扰（进度文案由安装任务自己刷）。
 */
export function zcodeBrowserStatus(): ZcodeBrowserStatus {
  if (status.state !== "installing") {
    const found = findZcodeBrowser()
    if (found && (status.state !== "ready" || status.path !== found.path)) {
      setStatus({
        state: "ready",
        path: found.path,
        source: found.source,
        version: found.version,
        message: undefined,
        download: undefined,
      })
    } else if (!found && status.state === "ready") {
      setStatus({
        state: "missing",
        path: undefined,
        message: "Chromium executable disappeared",
      })
    }
  }
  return { ...status }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function recordPath(): string {
  return path.join(PATHS.APP_DIR, RECORD_FILE)
}

interface BrowserRecord {
  path: string
  version?: string
  installedAt?: number
}

function readRecord(): BrowserRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(recordPath(), "utf8")) as unknown
    if (typeof raw !== "object" || raw === null) return undefined
    const record = raw as Record<string, unknown>
    const file = typeof record.path === "string" ? record.path : ""
    if (!file || !exists(file)) return undefined
    return {
      path: file,
      version: typeof record.version === "string" ? record.version : undefined,
      installedAt:
        typeof record.installedAt === "number" ? record.installedAt : undefined,
    }
  } catch {
    return undefined
  }
}

function writeRecord(record: BrowserRecord): void {
  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(recordPath(), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    })
  } catch (error) {
    logger.warn("Could not persist the ZCode browser path:", error)
  }
}

/** macOS 的应用包路径带空格，逐个探测。 */
function macChromeCandidates(): Array<string> {
  const home = os.homedir()
  const apps = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    path.join(
      home,
      "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
    path.join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
  ]
  return apps
}

function windowsChromeCandidates(): Array<string> {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value))
  return roots.flatMap((root) => [
    path.join(root, "Google/Chrome/Application/chrome.exe"),
    path.join(root, "Chromium/Application/chrome.exe"),
    path.join(root, "Microsoft/Edge/Application/msedge.exe"),
  ])
}

function systemCandidates(): Array<string> {
  const env = [
    process.env.ZCODE_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.GOOGLE_CHROME_BIN,
  ].filter((value): value is string => Boolean(value?.trim()))

  const perPlatform =
    process.platform === "darwin" ? macChromeCandidates()
    : process.platform === "win32" ? windowsChromeCandidates()
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/local/bin/chromium",
        "/usr/local/bin/google-chrome",
        "/snap/bin/chromium",
      ]

  return [...env, ...perPlatform]
}

/** 找现成的：env / 上次安装记录 / 系统路径。 */
function findZcodeBrowser():
  | { path: string; source: "env" | "system" | "managed"; version?: string }
  | undefined {
  const envPath = [
    process.env.ZCODE_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.GOOGLE_CHROME_BIN,
  ].find((value) => value && isExecutable(value))
  if (envPath) return { path: envPath, source: "env" }

  const recorded = readRecord()
  if (recorded) {
    return {
      path: recorded.path,
      source: "managed",
      version: recorded.version,
    }
  }

  const system = systemCandidates().find((candidate) => isExecutable(candidate))
  if (system) return { path: system, source: "system" }
  return undefined
}

function isMuslLinux(): boolean {
  if (process.platform !== "linux") return false
  return ["/etc/alpine-release", "/lib/ld-musl-x86_64.so.1"].some((file) =>
    exists(file),
  )
}

function unsupportedReason(): string | undefined {
  if (process.platform !== "linux") return undefined
  if (isMuslLinux()) {
    return "This Linux image uses musl (Alpine), where Chrome cannot run. Use a glibc image (e.g. Debian) or install Chromium and set ZCODE_CHROMIUM_PATH."
  }
  const platform = detectBrowserPlatform()
  if (!platform) {
    return `Chrome for Testing has no build for ${process.platform}/${process.arch}. Install Chromium and set ZCODE_CHROMIUM_PATH.`
  }
  return undefined
}

async function downloadBrowser(): Promise<string> {
  const platform = detectBrowserPlatform()
  if (!platform) {
    throw new ZcodeBrowserError(
      `Chrome for Testing has no build for ${process.platform}/${process.arch}`,
    )
  }
  const cacheDir = path.join(PATHS.APP_DIR, CACHE_DIR)
  setStatus({
    state: "installing",
    message: "Resolving the latest Chrome for Testing build…",
    download: undefined,
  })
  const buildId = await resolveBuildId(Browser.CHROME, platform, "stable")
  setStatus({ message: `Downloading Chrome ${buildId} (${platform})…` })
  const installed = await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir,
    downloadProgressCallback: (downloaded, total) => {
      setStatus({
        state: "installing",
        message: `Downloading Chrome ${buildId}…`,
        download: { downloaded, total },
      })
    },
  })
  const executable = installed.executablePath
  if (!isExecutable(executable)) {
    throw new ZcodeBrowserError(
      `Chrome was downloaded but ${executable} is not executable`,
    )
  }
  writeRecord({
    path: executable,
    version: installed.buildId,
    installedAt: Date.now(),
  })
  logger.info(`Installed Chrome for ZCode captcha solving: ${executable}`)
  return executable
}

function installOnce(): Promise<string> {
  if (installTask) return installTask
  const task = downloadBrowser()
    .then((executable) => {
      setStatus({
        state: "ready",
        path: executable,
        source: "managed",
        message: undefined,
        download: undefined,
      })
      return executable
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ?
          error.message
        : String(error || "unknown error")
      setStatus({
        state: "error",
        message: `Could not install Chromium: ${message}`,
        download: undefined,
      })
      throw error instanceof ZcodeBrowserError ? error : (
          new ZcodeBrowserError(message)
        )
    })
    .finally(() => {
      installTask = undefined
    })
  installTask = task
  return task
}

/**
 * 后台/手动触发的安装（不等待）：WebUI 点击安装后立即返回，靠
 * zcodeBrowserStatus() 轮询进度。
 */
export function startZcodeBrowserInstall(): ZcodeBrowserStatus {
  if (installTask) return zcodeBrowserStatus()
  const reason = unsupportedReason()
  if (reason) {
    setStatus({ state: "error", message: reason })
    return zcodeBrowserStatus()
  }
  void installOnce().catch(() => undefined)
  return zcodeBrowserStatus()
}

/** 需要浏览器时调用：已有就直接用，没有就装（并发调用共享同一次安装）。 */
export async function ensureZcodeBrowser(): Promise<string> {
  const found = findZcodeBrowser()
  if (found) {
    setStatus({
      state: "ready",
      path: found.path,
      source: found.source,
      version: found.version,
      message: undefined,
    })
    return found.path
  }
  const reason = unsupportedReason()
  if (reason) {
    setStatus({ state: "error", message: reason })
    throw new ZcodeBrowserError(reason)
  }
  return installOnce()
}

/** 测试用：清掉进程内状态。 */
export function __resetZcodeBrowserForTest(): void {
  status = { state: "missing", updatedAt: Date.now() }
  installTask = undefined
}
