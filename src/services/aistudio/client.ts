import { createHash, randomUUID } from "node:crypto"

import { HTTPError } from "~/lib/error"
import { oauthFetch } from "~/services/oauth/fetch"
import {
  AISTUDIO_ORIGIN,
  AISTUDIO_USER_AGENT,
  cookieHeader,
  parseCookieHeader,
  responseCookieUpdates,
  signAuthorization,
  type CookieUpdates,
} from "~/services/aistudio/auth"
import { loggingContextHeader, parseRpcJson } from "~/services/aistudio/rpc"
import { createWaaRuntime, type WAAChallenge } from "~/services/aistudio/waa"
import protocol from "~/services/aistudio/protocol.json"

const RPC_BASE =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/"
const WAA_URL =
  "https://waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.Waa/Create"
const PAGE_URL = `${AISTUDIO_ORIGIN}/prompts/new_chat?model=gemini-flash-latest&temporary=true`

interface ClientOptions {
  cookie: string
  proxyUrl?: string
  signal?: AbortSignal
  onCookieUpdate?(
    previous: ReadonlyMap<string, string>,
    updates: CookieUpdates,
  ): Promise<ReadonlyMap<string, string> | undefined>
}

/** One request owns its cookies and VM; nothing is shared between accounts. */
export class AIStudioClient {
  private cookies: Map<string, string>
  private apiKey = ""
  private benefitTier = 0
  private options: ClientOptions

  constructor(options: ClientOptions) {
    this.options = options
    try {
      this.cookies = parseCookieHeader(options.cookie)
    } catch {
      throw new HTTPError(
        "AI Studio Cookie is incomplete or expired; copy a fresh complete Cookie header.",
        new Response(null, { status: 401 }),
      )
    }
  }

  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const target = new URL(url)
    if (
      target.protocol !== "https:"
      || ![
        "aistudio.google.com",
        "www.google.com",
        "alkalimakersuite-pa.clients6.google.com",
        "waa-pa.clients6.google.com",
      ].includes(target.hostname)
      || target.username
      || target.password
    )
      throw new Error("AI Studio request destination is not allowed")
    const response = await oauthFetch(
      url,
      {
        ...init,
        redirect: "manual",
        headers: {
          "User-Agent": AISTUDIO_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.5",
          Cookie: cookieHeader(this.cookies),
          ...init.headers,
        },
      },
      {
        proxyUrl: this.options.proxyUrl,
        signal: AbortSignal.any([
          this.options.signal ?? new AbortController().signal,
          AbortSignal.timeout(120_000),
        ]),
      },
    )
    const updates = responseCookieUpdates(response.headers)
    if (updates.size) {
      const previous = new Map(this.cookies)
      for (const [name, value] of updates) {
        if (value === undefined) this.cookies.delete(name)
        else this.cookies.set(name, value)
      }
      try {
        const current = await this.options.onCookieUpdate?.(previous, updates)
        if (current) this.cookies = new Map(current)
      } catch (error) {
        await response.body?.cancel()
        throw error
      }
    }
    return response
  }

  private headers(key = this.apiKey): Record<string, string> {
    let authorization: string
    try {
      authorization = signAuthorization(this.cookies)
    } catch {
      throw new HTTPError(
        "AI Studio Cookie is incomplete or expired; copy a fresh complete Cookie header.",
        new Response(null, { status: 401 }),
      )
    }
    return {
      "Content-Type": "application/json+protobuf",
      Accept: "*/*",
      Origin: AISTUDIO_ORIGIN,
      Referer: `${AISTUDIO_ORIGIN}/`,
      Authorization: authorization,
      "X-Goog-Api-Key": key,
      "X-Goog-AuthUser": "0",
      "X-User-Agent": "grpc-web-javascript/0.1",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    }
  }

  private async checked(response: Response, stage: string): Promise<Response> {
    if (response.ok) return response
    await response.body?.cancel()
    const headers = new Headers(response.headers)
    // Credential rotations are already saved; never attach them to logged errors.
    headers.delete("set-cookie")
    const message = `AI Studio ${stage} failed (${response.status}); check the Cookie, account access and upstream quota.`
    throw new HTTPError(
      message,
      new Response(null, {
        status:
          response.status >= 300 && response.status < 400 ?
            401
          : response.status,
        headers,
      }),
      JSON.stringify({ error: { message } }),
    )
  }

  async initialize(): Promise<void> {
    const page = await this.checked(await this.request(PAGE_URL), "sign-in")
    const html = await page.text()
    this.apiKey = html.match(/"WIu0Nc":"([^"]+)"/)?.[1] ?? ""
    if (!this.apiKey)
      throw new HTTPError(
        "AI Studio sign-in expired or page format changed; copy a fresh complete Cookie header.",
        new Response(null, { status: 401 }),
      )
  }

  async rpc(
    method: "ListModels" | "GetLoggingContext" | "GetAiStudioBenefitTier",
    body: unknown[] = [],
  ): Promise<unknown> {
    const response = await this.checked(
      await this.request(RPC_BASE + method, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      }),
      method,
    )
    return parseRpcJson(await response.text())
  }

  async getBenefitTier(): Promise<number> {
    const result = await this.rpc("GetAiStudioBenefitTier")
    if (
      !Array.isArray(result)
      || (result[0] != null && ![0, 1, 2, 3].includes(result[0]))
    )
      throw new Error("Invalid AI Studio benefit tier")
    this.benefitTier = (result[0] as number | undefined) ?? 0
    return this.benefitTier
  }

  private async challenge(): Promise<{
    challenge: WAAChallenge
    interpreter: string
  }> {
    const response = await this.checked(
      await this.request(WAA_URL, {
        method: "POST",
        headers: this.headers(protocol.waaApiKey),
        body: JSON.stringify(["lmnUSbltwc5ULv48iKLX"]),
      }),
      "WAA challenge",
    )
    const outer = parseRpcJson(await response.text())
    if (!Array.isArray(outer)) throw new Error("Invalid AI Studio WAA response")
    const fields: unknown =
      typeof outer[1] === "string" && outer[1] ?
        JSON.parse(
          Buffer.from(
            [...Buffer.from(outer[1], "base64")].map(
              (byte) => (byte + 97) & 255,
            ),
          ).toString(),
        )
      : outer[0]
    if (!Array.isArray(fields))
      throw new Error("Invalid AI Studio WAA challenge")
    const first = (value: unknown): string =>
      Array.isArray(value) ?
        (value.find(
          (v: unknown): v is string => typeof v === "string" && v.length > 0,
        ) ?? "")
      : ""
    const url = first(fields[2]).replace(/^\/\//, "https://")
    const challenge: WAAChallenge = {
      globalName: typeof fields[5] === "string" ? fields[5] : "",
      program: typeof fields[4] === "string" ? fields[4] : "",
      clientExperimentsStateBlob:
        typeof fields[7] === "string" ? fields[7] : undefined,
      interpreterURL: url,
      interpreterHash: typeof fields[3] === "string" ? fields[3] : "",
    }
    let interpreter = first(fields[1])
    if (!interpreter) {
      if (!/^https:\/\/www\.google\.com\/js\/bg\/[A-Za-z0-9_-]+\.js$/.test(url))
        throw new Error("Invalid AI Studio interpreter URL")
      interpreter = await (
        await this.checked(await this.request(url), "interpreter")
      ).text()
    }
    if (
      createHash("sha256").update(interpreter).digest("base64url")
      !== challenge.interpreterHash
    )
      throw new Error("AI Studio interpreter integrity check failed")
    return { challenge, interpreter }
  }

  async generate(body: unknown[], binding: string): Promise<Response> {
    const logging = loggingContextHeader(await this.rpc("GetLoggingContext"))
    const loaded = await this.challenge()
    const runtime = createWaaRuntime({
      ...loaded,
      cookie: cookieHeader(this.cookies),
      proxyUrl: this.options.proxyUrl,
      signal: this.options.signal,
    })
    try {
      body[4] = await runtime.proof(binding)
    } finally {
      runtime.close()
    }
    return this.checked(
      await this.request(RPC_BASE + "GenerateContent", {
        method: "POST",
        headers: {
          ...this.headers(),
          ...(this.benefitTier ?
            {
              "X-AIStudio-G1-Tier": ["", "TIER1", "TIER2", "TIER0"][
                this.benefitTier
              ],
            }
          : {}),
          "X-Aistudio-Visit-Id": `v1_${Buffer.from(randomUUID()).toString("base64")}`,
          "X-Goog-Ext-519733851-Bin": logging,
        },
        body: JSON.stringify(body),
      }),
      "GenerateContent",
    )
  }
}
