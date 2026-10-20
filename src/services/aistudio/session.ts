import {
  getConnectionProxyUrl,
  getMutableProviderConnection,
  persistProviderConnections,
  type ApiCredential,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { cookieHeader, readCookieHeader } from "~/services/aistudio/auth"
import { AIStudioClient } from "~/services/aistudio/client"

// Track only our own rotations. An admin credential replacement starts a new
// generation, so in-flight responses cannot modify the replacement login.
const sessions = new WeakMap<ApiCredential, { value: string }>()

export function createAIStudioClient(
  connection: ProviderConnection,
  credential: ApiCredential,
  signal?: AbortSignal,
): AIStudioClient {
  let session = sessions.get(credential)
  if (!session || session.value !== credential.value) {
    session = { value: credential.value }
    sessions.set(credential, session)
  }
  const generation = session
  return new AIStudioClient({
    cookie: credential.value,
    proxyUrl: getConnectionProxyUrl(connection),
    signal,
    async onCookieUpdate(previous, updates) {
      if (
        getMutableProviderConnection(connection.id) !== connection
        || connection.credentials.find((item) => item.id === credential.id)
          !== credential
        || sessions.get(credential) !== generation
        || credential.value !== generation.value
      )
        return undefined

      const current = readCookieHeader(credential.value)
      for (const [name, value] of updates) {
        // Merge disjoint rotations, but never restore a value already replaced
        // or deleted by a concurrent request from the same cookie generation.
        if (current.get(name) !== previous.get(name)) continue
        if (value === undefined) current.delete(name)
        else current.set(name, value)
      }
      const next = cookieHeader(current)
      if (next !== credential.value) {
        // No await between the live-state check and this in-memory mutation.
        // The existing persistence queue serializes all subsequent disk writes.
        credential.value = next
        generation.value = next
        connection.updatedAt = Date.now()
        await persistProviderConnections()
      }
      return (
          getMutableProviderConnection(connection.id) === connection
            && connection.credentials.includes(credential)
            && sessions.get(credential) === generation
            && credential.value === generation.value
        ) ?
          readCookieHeader(credential.value)
        : undefined
    },
  })
}
