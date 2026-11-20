import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

import { HTTPError } from "~/lib/error"
import { asNumber, asRecord, asTrimmedString } from "~/lib/json-shape"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"

export const ASTUDIO_MODEL_ORIGIN =
  "https://astronstudio-api-volces-prod.xf-yun.com"
const STUDIO_API = "https://agent.xfyun.cn/xingchen-studio/"

interface StudioSession {
  studioAccountId: string
  sessionToken?: string
  ssoSessionId?: string
}

// Cookie-octet: prevent a manually pasted form value from escaping its cookie.
function cookieValue(raw: unknown): string | undefined {
  const value = asTrimmedString(raw)
  if (!value) return undefined
  if (
    value.length > 8192
    || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(value)
  ) {
    throw new Error("Invalid Astron Studio session field")
  }
  return value
}

export function studioSession(
  raw?: Record<string, unknown>,
): StudioSession | undefined {
  const studioAccountId = cookieValue(raw?.studioAccountId)
  const sessionToken = cookieValue(raw?.sessionToken)
  const ssoSessionId = cookieValue(raw?.ssoSessionId)
  if (!studioAccountId || (!sessionToken && !ssoSessionId)) return undefined
  return { studioAccountId, sessionToken, ssoSessionId }
}

function sessionFromCookieHeader(raw: string): StudioSession {
  if (raw.length > 32768 || /[^\x20-\x7e\t]/.test(raw)) {
    throw new Error("Invalid Astron Studio Cookie header")
  }
  const header = raw.replace(/^cookie:\s*/i, "")
  const fields: Record<string, string> = {}
  for (const part of header.split(";")) {
    const sep = part.indexOf("=")
    if (sep < 0) continue
    const name = part.slice(0, sep).trim()
    const field =
      name === "account_id" ? "studioAccountId"
      : name === "token" ? "sessionToken"
      : ["ssoSessionId", "sso_sessionid"].includes(name) ? "ssoSessionId"
      : undefined
    if (!field) continue
    const value = cookieValue(part.slice(sep + 1))
    if (!value) continue
    if (fields[field] !== undefined && fields[field] !== value) {
      throw new Error("Conflicting Astron Studio session cookies")
    }
    fields[field] = value
  }
  const session = studioSession(fields)
  if (!session)
    throw new Error("Missing Astron Studio account or session cookie")
  return session
}

export async function studioJson(
  path: string,
  session: StudioSession,
  options: OAuthFetchOptions,
  method: "GET" | "POST" = "GET",
) {
  const cookie = [
    `account_id=${session.studioAccountId}`,
    ...(session.sessionToken ? [`token=${session.sessionToken}`] : []),
    ...(session.ssoSessionId ?
      [
        `ssoSessionId=${session.ssoSessionId}`,
        `sso_sessionid=${session.ssoSessionId}`,
      ]
    : []),
  ].join("; ")
  const response = await oauthFetch(
    `${STUDIO_API}${path}`,
    {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        clientType: process.platform === "darwin" ? "22" : "21",
        studioVersion: "3.5.5",
        Cookie: cookie,
      },
    },
    options,
  )
  const payload = asRecord(await response.json().catch(() => undefined))
  const code = asNumber(payload?.code)
  if (response.status === 401 || response.status === 403 || code === 80000) {
    // An expired web cookie is not proof that the long-lived model bearer is invalid.
    throw new Error(
      "Astron Studio web session expired; supply a new session to refresh quota",
    )
  }
  if (
    !response.ok
    || !payload
    || payload.flag === false
    || (code !== undefined && code !== 0)
  ) {
    throw new HTTPError(
      "Astron Studio account request failed",
      new Response(null, { status: response.ok ? 502 : response.status }),
    )
  }
  return asRecord(payload.data)
}

function modelToken(raw: unknown): string | undefined {
  const token = asTrimmedString(raw)?.replace(/^Bearer\s+/i, "")
  if (!token) return undefined
  if (token.length > 4096 || !/^[\x21-\x7e]+$/.test(token))
    throw new Error("Invalid Astron Studio model bearer token")
  return token
}

async function readDesktopSnapshot(): Promise<
  Record<string, unknown> | undefined
> {
  const configured = process.env.ASTUDIO_HOME || process.env.SYNARA_HOME
  const home = join(homedir(), ".acode", "acode")
  for (const root of configured ? [configured, home] : [home]) {
    const file = Bun.file(join(root, "userdata", "astron-session.json"))
    if ((await file.exists()) && file.size <= 256 * 1024) {
      const row = asRecord(await file.json())
      if (row?.modelBearerToken || row?.banned === true) return row
    }
  }
  const configs = [
    ...(configured ?
      [join(configured, "runtime", "acode-home", "config.toml")]
    : []),
    join(home, "config.toml"),
  ]
  for (const path of configs) {
    const file = Bun.file(path)
    if (!(await file.exists()) || file.size > 256 * 1024) continue
    const section = (await file.text())
      .split(/^\s*\[/m)
      .find((part) => /^\s*model_providers\s*\.\s*astron-spark\s*\]/.test(part))
    const token = section?.match(
      /^\s*experimental_bearer_token\s*=\s*"([^"]+)"\s*$/m,
    )?.[1]
    if (token) return { modelBearerToken: token }
  }
  return undefined
}

export const studioAccountCreation: ProviderAccountCreation = {
  async prepare({ body, label }) {
    try {
      const settings = { ...body.settings }
      const accountId =
        body.credentials?.studioAccountId
        ?? body.credentials?.accountId
        ?? settings.studioAccountId
        ?? settings.accountId
      const importDesktop =
        body.credentials?.importDesktop === true
        || settings.importDesktop === true
      for (const key of [
        "studioAccountId",
        "accountId",
        "sessionToken",
        "ssoSessionId",
        "modelBearerToken",
        "importDesktop",
        "sessionCookie",
        "uid",
      ])
        delete settings[key]
      const input = credentialString(body, "modelBearerToken", body.apiKey)
      const sessionCookie = credentialString(body, "sessionCookie")
      let pastedSession: StudioSession | undefined
      if (sessionCookie) {
        if (importDesktop || input?.startsWith("{")) {
          return {
            error:
              "Use either an Astron Studio web Cookie or a desktop session, not both",
          }
        }
        try {
          pastedSession = sessionFromCookieHeader(sessionCookie)
        } catch {
          return {
            error:
              "Paste an Astron Studio Cookie header with account_id and token or ssoSessionId, without conflicting values",
          }
        }
      }
      const snapshot =
        importDesktop ? await readDesktopSnapshot()
        : input?.startsWith("{") ? asRecord(JSON.parse(input))
        : undefined
      if (importDesktop && !snapshot) {
        return {
          error:
            "No Astron Studio desktop credential was found on the proxy host",
        }
      }
      if (snapshot?.banned === true)
        return { error: "Astron Studio desktop account is banned" }
      const fields = {
        studioAccountId: snapshot ? snapshot.accountId : accountId,
        sessionToken:
          snapshot ? snapshot.token : body.credentials?.sessionToken,
        ssoSessionId:
          snapshot ? snapshot.ssoSessionId : body.credentials?.ssoSessionId,
      }
      const session = pastedSession ?? studioSession(fields)
      if (!snapshot && !session && Object.values(fields).some(Boolean))
        return {
          error:
            "Supply account_id and either the token or ssoSessionId cookie",
        }
      const proxyUrl = asTrimmedString(settings.proxyUrl)
      let modelBearerToken = modelToken(
        snapshot ? snapshot.modelBearerToken : input,
      )
      if (!modelBearerToken && session) {
        const bundle = await studioJson(
          "auth/bearer-token",
          session,
          { proxyUrl },
          "POST",
        )
        modelBearerToken = modelToken(bundle?.modelBearerToken)
      }
      if (!modelBearerToken)
        return {
          error:
            "Supply an Astron Studio model bearer or a signed-in web session",
        }
      return {
        id: randomUUID(),
        name: label,
        provider: "astudio",
        settings,
        credentials: {
          modelBearerToken,
          ...session,
          uid: asTrimmedString(snapshot ? snapshot.uid : body.credentials?.uid),
        },
      }
    } catch (error) {
      // Do not return parse errors that may quote fragments of pasted secrets.
      return {
        error:
          error instanceof SyntaxError ?
            "Invalid Astron Studio session JSON"
          : "Could not prepare Astron Studio credentials; verify the token or web session",
      }
    }
  },
}
