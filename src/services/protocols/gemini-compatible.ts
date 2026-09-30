/**
 * Gemini `generateContent`-compatible Protocol Adapter.
 *
 * Serves the public Gemini wire (`POST /v1beta/models/{model}:generateContent`
 * and `:streamGenerateContent`) against a manually configured upstream
 * (e.g. `https://generativelanguage.googleapis.com/v1beta`).
 *
 * The "-compatible" suffix follows this repo's taxonomy for
 * endpoint connections (the `*-native` suffix is reserved for
 * account-managed providers); it says nothing about the wire, which is
 * Google's own generateContent protocol.
 *
 * Translation to and from the shared IR lives in `~/services/ir/codecs/gemini`.
 */

import type { ModelMapping } from "~/lib/provider-connections"
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
} from "~/services/protocols/gemini"

import {
  buildBaseHeaders,
  detectOpenAIStreamError,
  handleUpstreamFailure,
  joinUrl,
  safeSseStream,
} from "~/services/protocols/shared"

import type { AdapterGeminiResult, ProtocolAdapter } from "./types"

/** `models/` prefix is implied by the path and must not be repeated. */
function modelPath(model: string): string {
  return model
    .trim()
    .replace(/^\/+/, "")
    .replace(/^models\//, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

function upstreamBody(
  payload: GeminiGenerateContentRequest,
): GeminiGenerateContentRequest {
  const { model: _model, stream: _stream, ...rest } = payload
  return rest as GeminiGenerateContentRequest
}

export const geminiCompatibleAdapter: ProtocolAdapter = {
  protocol: "gemini-compatible",

  async discoverModels({ connection, credential, signal }) {
    const endpoint =
      connection.modelDiscovery?.endpoint
      ?? joinUrl(connection.baseUrl, "/models")
    const url =
      /^https?:/i.test(endpoint) ? endpoint : (
        joinUrl(connection.baseUrl, endpoint)
      )
    const response = await fetch(url, {
      headers: buildBaseHeaders(connection, credential),
      signal,
    })
    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to discover models",
        "gemini-compatible",
      )
    }
    const body = (await response.json()) as {
      models?: Array<{
        name?: string
        displayName?: string
        supportedGenerationMethods?: Array<string>
      }>
    }
    return (body.models ?? [])
      .filter(
        (model) =>
          typeof model.name === "string"
          && (model.supportedGenerationMethods?.includes("generateContent")
            ?? true),
      )
      .map<ModelMapping>((model) => {
        const id = (model.name ?? "").replace(/^models\//, "")
        return {
          publicId: id,
          upstreamId: id,
          name: model.displayName,
          endpoints: ["gemini"],
          enabled: true,
          pickerEnabled: true,
        }
      })
  },

  async createGeminiGenerateContent({
    target,
    connection,
    credential,
    payload,
    signal,
  }) {
    const stream = payload.stream === true
    const action = stream ? "streamGenerateContent" : "generateContent"
    const url = `${joinUrl(
      connection.baseUrl,
      `/models/${modelPath(target.upstreamModelId)}:${action}`,
    )}${stream ? "?alt=sse" : ""}`
    const response = await fetch(url, {
      method: "POST",
      headers: buildBaseHeaders(connection, credential),
      body: JSON.stringify(upstreamBody(payload)),
      signal,
    })
    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to generate content",
        "gemini-compatible",
      )
    }
    if (stream) {
      // Gemini streams SSE frames shaped `{error: {code, message, status}}`,
      // which is what detectOpenAIStreamError already recognizes.
      const body = await safeSseStream(response, detectOpenAIStreamError)
      return {
        credentialId: credential.id,
        response: body,
      } satisfies AdapterGeminiResult
    }
    const body = (await response.json()) as GeminiGenerateContentResponse
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterGeminiResult
  },
}
