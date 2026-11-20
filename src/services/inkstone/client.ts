import { isRecord } from "~/lib/json-shape"
import { readResponseBytes } from "~/lib/request-body"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"

// Keep browser-session requests on the console origin, never the inference origin.
export const INKSTONE_API = "https://discovery-api.intern-ai.org.cn/v1"
const CONSOLE = "https://discovery.intern-ai.org.cn"
const CONSOLE_API = `${CONSOLE}/api/tokenplan/v1`
const CONSOLE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"

export class InkstoneRequestError extends Error {
  readonly status?: number

  constructor(operation: string, status?: number, vendorCode?: number) {
    super(
      `InkStone ${operation} failed${status !== undefined ? ` (HTTP ${status}${vendorCode ? `, code ${vendorCode}` : ""})` : ""}.`,
    )
    this.status = status
  }
}

export function nonnegative(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim()))
    return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

async function readInkstoneJson(
  url: string,
  init: RequestInit,
  options?: OAuthFetchOptions,
): Promise<Record<string, unknown>> {
  const operation = new URL(url).pathname.split("/").at(-1) ?? "request"
  try {
    const timeout = AbortSignal.timeout(20_000)
    const signal =
      options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const response = await oauthFetch(
      url,
      { ...init, redirect: "error" },
      { ...options, signal },
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new InkstoneRequestError(operation, response.status)
    }
    const bytes = await readResponseBytes(response, 2 * 1024 * 1024)
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!isRecord(body)) throw new InkstoneRequestError(operation)
    const code = typeof body.code === "number" ? body.code : undefined
    if (code) throw new InkstoneRequestError(operation, response.status, code)
    return body
  } catch (error) {
    options?.signal?.throwIfAborted()
    // Never surface console bodies or fetch diagnostics that may echo credentials.
    throw error instanceof InkstoneRequestError ? error : (
        new InkstoneRequestError(operation)
      )
  }
}

export function readApiModels(
  key: string,
  options?: OAuthFetchOptions,
): Promise<Record<string, unknown>> {
  return readInkstoneJson(
    `${INKSTONE_API}/models`,
    { headers: { accept: "application/json", authorization: `Bearer ${key}` } },
    options,
  )
}

export function readPublicModels(
  options?: OAuthFetchOptions,
): Promise<Record<string, unknown>> {
  return readInkstoneJson(
    `${CONSOLE_API}/public/models?page=1&page_size=50`,
    { headers: consoleHeaders() },
    options,
  )
}

type ConsoleResource = "credits/balance" | "credits/packages" | "users/validate"

function consoleHeaders() {
  return {
    accept: "application/json",
    "accept-language": "zh-CN",
    origin: CONSOLE,
    referer: `${CONSOLE}/token-plan/home`,
    "user-agent": CONSOLE_USER_AGENT,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "sec-ch-ua":
      '"Chromium";v="152", "Not;A=Brand";v="24", "Google Chrome";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  }
}

export async function readConsole(
  resource: ConsoleResource,
  token: string,
  options?: OAuthFetchOptions,
): Promise<unknown> {
  const reply = await readInkstoneJson(
    `${CONSOLE_API}/${resource}`,
    { headers: { ...consoleHeaders(), authorization: `Bearer ${token}` } },
    options,
  )
  return reply.data
}

export async function readKeys(
  token: string,
  options?: OAuthFetchOptions,
): Promise<unknown> {
  return (
    await readInkstoneJson(
      `${CONSOLE_API}/keys`,
      { headers: { ...consoleHeaders(), cookie: `uaa-token=${token}` } },
      options,
    )
  ).data
}

export async function createKey(
  token: string,
  name: string,
  idempotencyKey: string,
  options?: OAuthFetchOptions,
): Promise<unknown> {
  return (
    await readInkstoneJson(
      `${CONSOLE_API}/keys`,
      {
        method: "POST",
        headers: {
          ...consoleHeaders(),
          cookie: `uaa-token=${token}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ name }),
      },
      options,
    )
  ).data
}
