import { createAIStudioClient } from "~/services/aistudio/session"
import { decodeAIStudioModels } from "~/services/aistudio/models"
import {
  encodeGenerateRequest,
  decodeGenerateStream,
  collectGenerateResponse,
} from "~/services/aistudio/codec"
import type { ProtocolAdapter } from "~/services/protocols/types"

export const aistudioNativeAdapter: ProtocolAdapter = {
  protocol: "aistudio-native",
  async discoverModels({ connection, credential, signal }) {
    const client = createAIStudioClient(connection, credential, signal)
    await client.initialize()
    return decodeAIStudioModels(await client.rpc("ListModels"))
  },
  async createGeminiGenerateContent({
    target,
    connection,
    credential,
    payload,
    signal,
  }) {
    const metadata = connection.models?.find(
      (model) => model.upstreamId === target.upstreamModelId,
    )?.metadata
    const encoded = encodeGenerateRequest(
      payload,
      target.upstreamModelId,
      metadata,
    )
    const client = createAIStudioClient(connection, credential, signal)
    await client.initialize()
    const upstream = await client.generate(encoded.body, encoded.binding)
    const chunks = (async function* () {
      for await (const chunk of decodeGenerateStream(upstream, signal)) {
        if (
          payload.generationConfig?.thinkingConfig?.includeThoughts === false
        ) {
          for (const candidate of chunk.candidates ?? []) {
            if (candidate.content)
              candidate.content.parts = candidate.content.parts.flatMap(
                (part) =>
                  !part.thought ? [part]
                  : part.thoughtSignature ?
                    [{ thoughtSignature: part.thoughtSignature }]
                  : [],
              )
          }
        }
        yield chunk
      }
    })()
    if (payload.stream)
      return {
        credentialId: credential.id,
        response: (async function* () {
          for await (const chunk of chunks)
            yield { data: JSON.stringify(chunk) }
        })(),
      }
    return {
      credentialId: credential.id,
      response: await collectGenerateResponse(chunks),
    }
  },
}
