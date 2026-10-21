import { LocalPayloadUnsupportedError } from "~/lib/error"
import { createAIStudioClient } from "~/services/aistudio/session"
import {
  decodeAIStudioModels,
  isAIStudioModelAllowed,
} from "~/services/aistudio/models"
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
    const catalog = await client.rpc("ListModels")
    return decodeAIStudioModels(catalog, await client.getBenefitTier())
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
    if (metadata?.supported === false)
      throw new LocalPayloadUnsupportedError(
        "AI Studio: this model requires an unsupported upstream route (for example Interactions, Live or media generation).",
      )
    const encoded = encodeGenerateRequest(
      payload,
      target.upstreamModelId,
      metadata,
    )
    const client = createAIStudioClient(connection, credential, signal)
    await client.initialize()
    const tier = await client.getBenefitTier()
    if (
      !isAIStudioModelAllowed(
        Array.isArray(metadata?.accessModes) ? metadata.accessModes : [],
        tier,
      )
    )
      throw new LocalPayloadUnsupportedError(
        "AI Studio: this account does not have the model's required subscription or paid API-key access.",
      )
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
