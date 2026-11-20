import { LocalPayloadUnsupportedError } from "~/lib/error"
import { asRecord } from "~/lib/json-shape"
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { providerMetadata } from "~/lib/provider-descriptors/doubao-work"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import {
  DoubaoWorkBridge,
  type WorkConnection,
} from "~/services/doubao-work/bridge"
import {
  fallbackModels,
  workModelMappings,
  type WorkModel,
} from "~/services/doubao-work/catalog"
import { chatResult, streamChat, workPrompt } from "~/services/doubao-work/chat"
import { LocalDesktop } from "~/services/doubao-work/desktop"
import type { ProtocolAdapter } from "~/services/protocols/types"
import type { ProviderModule } from "~/services/providers/module"

const { descriptor, protocol } = providerMetadata
const defaultBridge = new DoubaoWorkBridge(new LocalDesktop())
// Keep the stored provider/protocol valid without exposing the desktop bridge.
const disabledAdapter: ProtocolAdapter = { protocol }
const disabledModule: ProviderModule = {
  id: descriptor.id,
  descriptor,
  adapter: disabledAdapter,
  quota: { source: "none" },
  createRuntime: () => ({
    id: descriptor.id,
    descriptor,
    adapter: disabledAdapter,
    supports: () => false,
    refreshModels: async (connection) => connection.models ?? [],
  }),
  accountCreation: {
    prepare: () => ({ error: "Doubao Work is temporarily disabled." }),
  },
}

export function getDisabledDoubaoWorkModule(): ProviderModule {
  return disabledModule
}

function credentials(
  connection: ProviderConnection,
  credential = connection.credentials[0],
): WorkConnection {
  return {
    id: connection.id,
    secret: credential?.enabled ? credential.value : "",
  }
}

function savedModels(connection: ProviderConnection): Array<WorkModel> {
  return (connection.models ?? []).flatMap((model) => {
    const saved = asRecord(model.metadata?.doubaoWork)
    if (typeof saved?.label !== "string") return []
    return [
      {
        id: model.upstreamId,
        label: saved.label,
        key: typeof saved.key === "string" ? saved.key : undefined,
        defaultLevel:
          typeof saved.defaultLevel === "string" ?
            saved.defaultLevel
          : undefined,
        levels: model.efforts,
        upgrade: saved.upgrade === true,
      },
    ]
  })
}

function chatAdapter(bridge: DoubaoWorkBridge): ProtocolAdapter {
  return {
    protocol,
    discoverModels: async ({ connection, credential, signal }) => {
      const models = await bridge.refreshModels(
        credentials(connection, credential),
        signal,
      )
      return models ?
          workModelMappings(models)
        : (connection.models ?? workModelMappings(fallbackModels))
    },
    async createChatCompletions({
      connection,
      credential,
      target,
      payload,
      signal,
      ctx,
    }) {
      if (payload.n != null && payload.n !== 1) {
        throw new LocalPayloadUnsupportedError(
          "Doubao Work can return only one reply per task.",
        )
      }
      const prompt = workPrompt(payload)
      const request = {
        ...credentials(connection, credential),
        model: target.upstreamModelId,
        effort: payload.reasoning_effort ?? payload.reasoning?.effort,
        prompt: prompt.text,
      }
      const saved = savedModels(connection)
      if (payload.stream || ctx?.preferStreamingResponse) {
        const response = await streamChat(
          payload.model,
          prompt,
          (onUpdate, activeSignal) =>
            bridge.ask({ ...request, onUpdate, signal: activeSignal }, saved),
          signal,
        )
        return { credentialId: credential.id, response }
      }
      return {
        credentialId: credential.id,
        response: chatResult(
          payload.model,
          prompt,
          await bridge.ask({ ...request, signal }, saved),
        ),
      }
    },
  }
}

function firstCredential(
  connection: ProviderConnection,
): ApiCredential | undefined {
  return connection.credentials.find((entry) => entry.enabled && entry.value)
}

const defaultAdapter = chatAdapter(defaultBridge)

export function getDoubaoWorkModule(bridge = defaultBridge): ProviderModule {
  const quota = { source: "poll" } as const
  const adapter =
    bridge === defaultBridge ? defaultAdapter : chatAdapter(bridge)
  const fetchQuota: NonNullable<ProviderModule["fetchQuota"]> = (
    connection,
    signal,
  ) => bridge.quota(credentials(connection), signal)
  const discoverModels: NonNullable<ProviderModule["discoverModels"]> = async (
    connection,
    signal,
  ) => {
    const credential = firstCredential(connection)
    if (!credential || !adapter.discoverModels) return []
    return adapter.discoverModels({ connection, credential, signal })
  }
  return {
    id: descriptor.id,
    descriptor,
    quota,
    adapter,
    fallbackModels: () => workModelMappings(fallbackModels),
    discoverModels,
    fetchQuota,
    createRuntime: () => ({
      id: descriptor.id,
      descriptor,
      quota,
      adapter,
      supports: (connection, feature) =>
        connection.protocol === protocol
        && descriptor.features.includes(feature),
      refreshModels: discoverModels,
      refreshQuota: (connection, signal, options) =>
        refreshProviderQuota(connection, fetchQuota, signal, options),
      getFallbackModels: (connection) =>
        connection.models ?? workModelMappings(fallbackModels),
    }),
    accountCreation: {
      async prepare({ body, label }) {
        // An admin explicitly opens a new browser profile, signs in in the
        // desktop window, then confirms the returned one-time nonce.
        const action = body.credentials?.desktopAction
        try {
          if (action === "start") {
            const { nonce, expiresAt } = await bridge.startSignIn()
            return {
              response: {
                status: "awaiting_desktop_sign_in",
                nonce,
                expiresAt,
              },
            }
          }
          const nonce = body.credentials?.desktopNonce
          if (action === "cancel" && typeof nonce === "string") {
            await bridge.cancelSignIn(nonce)
            return { response: { status: "cancelled" } }
          }
          if (action === "confirm" && typeof nonce === "string") {
            const { id, secret, models } = await bridge.finishSignIn(nonce)
            return {
              id,
              name: label,
              provider: descriptor.id,
              credentials: { desktopBinding: secret },
              availableModels: workModelMappings(models).map((model) => ({
                id: model.publicId,
                upstreamId: model.upstreamId,
                name: model.name ?? model.publicId,
                vendor: descriptor.id,
                pickerEnabled: true,
                supportedEndpoints: ["chat/completions"],
                efforts: model.efforts,
                metadata: model.metadata,
              })),
            }
          }
        } catch (error) {
          return {
            error:
              error instanceof Error ?
                error.message
              : "Doubao Work desktop sign-in failed.",
          }
        }
        return {
          error:
            "Doubao Work requires an explicit desktop sign-in (desktopAction: start, then confirm).",
        }
      },
    },
  }
}
