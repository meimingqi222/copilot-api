import { randomUUID } from "node:crypto"
import { HTTPError } from "~/lib/error"
import { asNumber, asRecord, asTrimmedString } from "~/lib/json-shape"
import {
  getMutableProviderConnection,
  setConnectionAuthStatus,
} from "~/lib/provider-connections"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import {
  fetchMeooQuota,
  MEOO_CLIENT_ID,
  MEOO_GATEWAY,
  MEOO_SITE,
  projectKey,
  requestMeooTokens,
  resolveMeooProject,
  type MeooTokens,
} from "~/services/meoo/client"
import {
  discoverMeooModels,
  listMeooModels,
  meooFallbackModels,
  meooNativeAdapter,
} from "~/services/meoo/gateway"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import type { OAuthFetchOptions } from "~/services/oauth/fetch"
import { generateOAuthState, generatePkceCodes } from "~/services/oauth/pkce"
import {
  applyFlowSettingsToConnection,
  createOAuthConnection,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"
import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import type { ProviderModule } from "~/services/providers/module"
import { defineOAuthProviderModule } from "~/services/providers/modules/define"

const CALLBACK_PORT = 14556
const CALLBACK_PATH = "/oauth/callback"
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`
const meooCallback: OAuthCallbackConfig = {
  port: CALLBACK_PORT,
  callbackPath: CALLBACK_PATH,
  providerLabel: "Meoo",
  parseQuery(params) {
    const code = params.get("code")
    const state = params.get("state")
    if (
      code
      && state
      && code.length <= 4096
      && !code.includes("\0")
      && !params.has("error")
      && params.getAll("code").length === 1
      && params.getAll("state").length === 1
    )
      return { code: `${state}\0${code}`, state }
    return undefined
  },
}

function meooContext(
  tokens: MeooTokens,
  project: Awaited<ReturnType<typeof resolveMeooProject>>,
): Record<string, unknown> {
  const user = project.userId ?? tokens.openid
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    projectUrlId: project.projectUrlId,
    serviceAk: project.serviceAk,
    ...(user ? { oauthAccountId: `${user}:${project.projectUrlId}` } : {}),
  }
}

const meooStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const pkce = generatePkceCodes()
    const state = generateOAuthState()
    const query = new URLSearchParams({
      response_type: "code",
      client_id: MEOO_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "cli.compat",
      state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    })
    return Promise.resolve({
      pkce,
      state,
      authUrl: `${MEOO_SITE}/oauth/authorize?${query}`,
      redirectUri: REDIRECT_URI,
    })
  },
  async exchange({ flow, code: callback, signal }) {
    const fields = callback?.split("\0")
    const code = fields?.[1]
    if (
      !flow.pkce
      || !flow.state
      || fields?.length !== 2
      || fields[0] !== flow.state
      || !code
      || code.length > 4096
    ) {
      throw new Error(
        "Meoo authorization callback did not match the sign-in flow.",
      )
    }
    const options = { proxyUrl: flow.proxyUrl, signal }
    const tokens = await requestMeooTokens(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: flow.pkce.codeVerifier,
      },
      options,
    )
    const project = await resolveMeooProject(tokens.accessToken, options)
    const connection = createOAuthConnection("meoo", flow.label)
    applyFlowSettingsToConnection(connection, flow)
    connection.baseUrl = MEOO_GATEWAY
    const credential = connection.credentials[0]
    credential.value = tokens.accessToken
    credential.context = meooContext(tokens, project)
    setConnectionAuthStatus(connection, "ready")
    return connection
  },
}

async function importMeooState(
  state: Record<string, unknown>,
  options: OAuthFetchOptions,
): Promise<Record<string, unknown>> {
  if (
    state.apiBaseUrl !== undefined
    && state.apiBaseUrl !== MEOO_SITE
    && state.apiBaseUrl !== `${MEOO_SITE}/`
  ) {
    throw new Error("Only production Meoo credentials can be imported.")
  }
  const accessToken = asTrimmedString(state.accessToken)
  const refreshToken = asTrimmedString(state.refreshToken)
  const expiresAt = asNumber(state.accessExpiresAt) ?? 0
  if (!accessToken || expiresAt <= Date.now()) {
    const key = projectKey(state.serviceAk)
    if (!refreshToken && key) {
      await listMeooModels(key, options)
      return { accessToken: key }
    }
    if (!refreshToken)
      throw new Error(
        "Meoo import needs an unexpired access token, refresh token, or project service AK.",
      )
  }
  const tokens =
    accessToken && expiresAt > Date.now() ?
      { accessToken, refreshToken, expiresAt }
    : await requestMeooTokens(
        { grant_type: "refresh_token", refresh_token: refreshToken ?? "" },
        options,
      )
  const project = await resolveMeooProject(
    tokens.accessToken,
    options,
    asTrimmedString(state.projectUrlId ?? state.serviceAkProjectId),
  )
  const context = meooContext(
    { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken },
    project,
  )
  return { ...context, accountId: context.oauthAccountId }
}

const accountCreation: ProviderAccountCreation = {
  async prepare({ body, label }) {
    const candidate =
      credentialString(body, "serviceAk", body.apiKey ?? body.authToken)
      ?? credentialString(body, "pat")
    const state = asRecord(body.credentials?.legacyState)
    const proxyUrl = asTrimmedString(body.settings?.proxyUrl)
    const ak = projectKey(candidate)
    if (candidate && !ak)
      return {
        error:
          "Use a meoo_project_service_v1. project service AK, not a Meoo user key.",
      }
    if (!ak && !state)
      return {
        error:
          "A Meoo project service AK or explicit legacyState import is required.",
      }
    try {
      let credentials: Record<string, unknown>
      if (ak) {
        await listMeooModels(ak, { proxyUrl })
        credentials = { accessToken: ak }
      } else if (state) {
        credentials = await importMeooState(state, { proxyUrl })
      } else throw new Error("Missing Meoo credential.")
      return {
        id: randomUUID(),
        name: label,
        provider: "meoo",
        credentials,
        settings: { proxyUrl },
      }
    } catch (error) {
      if (
        error instanceof HTTPError
        && [400, 401, 403].includes(error.response.status)
      )
        return {
          error:
            "Meoo refused the credential; sign in again or check the project service AK.",
        }
      return {
        error: "Could not validate the Meoo credential and project.",
        status: 502,
      }
    }
  },
}

const refreshDraft = prepareOAuthRefresh(
  async (draft, refreshToken, options) => {
    const incoming = await requestMeooTokens(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      options,
    )
    const credential = draft.credentials[0]
    credential.value = incoming.accessToken
    credential.context = {
      ...credential.context,
      accessToken: incoming.accessToken,
      expiresAt: incoming.expiresAt,
      refreshToken: incoming.refreshToken ?? refreshToken,
      ...(incoming.scope ? { scope: incoming.scope } : {}),
    }
    setConnectionAuthStatus(draft, "ready")
  },
)

const refreshAuth: NonNullable<ProviderModule["refreshAuth"]> = async (
  connection,
  refreshToken,
  options,
) => {
  const current = connection.credentials[0]
  const value = current?.value
  const context = current?.context
  const checkCurrent = () => {
    const live = getMutableProviderConnection(connection.id)
    if (
      (live && live !== connection)
      || connection.credentials[0] !== current
      || current?.value !== value
      || current?.context !== context
      || context?.refreshToken !== refreshToken
    ) {
      throw new Error(
        "Meoo credentials changed during refresh; ignoring the old result.",
      )
    }
  }
  checkCurrent()
  try {
    const update = await refreshDraft(connection, refreshToken, options)
    checkCurrent()
    return update
  } catch (error) {
    // An old terminal refusal must not mark newly installed credentials expired.
    checkCurrent()
    throw error
  }
}

export function getMeooModule(): ProviderModule {
  const module = defineOAuthProviderModule({
    id: "meoo",
    quota: { source: "poll" },
    callback: meooCallback,
    oauth: meooStrategy,
    adapter: meooNativeAdapter,
    refreshAuth,
    accountCreation,
    fetchQuota: fetchMeooQuota,
    discoverModels: discoverMeooModels,
    fallbackModels: meooFallbackModels,
    async afterAuthentication(connection) {
      if (!connection.credentials[0]?.context?.refreshToken) return
      const { scheduleOAuthRefreshForConnection } = await import(
        "~/services/oauth/refresh-scheduler"
      )
      scheduleOAuthRefreshForConnection(connection)
    },
  })
  const createRuntime = module.createRuntime
  return {
    ...module,
    createRuntime: () => ({
      ...createRuntime(),
      refreshModels: discoverMeooModels,
      getFallbackModels: (connection) =>
        connection.models?.length ? connection.models : meooFallbackModels(),
      refreshQuota: (connection, signal, options) =>
        refreshProviderQuota(connection, fetchMeooQuota, signal, {
          ...options,
          async prepare(current, abort) {
            abort?.throwIfAborted()
            const credential = current.credentials[0]
            if (credential?.context?.refreshToken)
              await ensureOAuthConnectionAccessToken(current, credential)
            abort?.throwIfAborted()
          },
        }),
    }),
  }
}
