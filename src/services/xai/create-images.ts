import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { canonicalNativeModelId } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { getConnectionSettings } from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { XAI_API_BASE_URL } from "~/services/oauth/xai"

import { buildXaiHeaders } from "./headers"

/**
 * OpenAI-compatible image generation request payload.
 * https://platform.openai.com/docs/api-reference/images/create
 */
export interface ImageGenerationRequest {
  model: string
  prompt: string
  n?: number
  size?: string
  response_format?: "b64_json" | "url"
  quality?: string
  style?: string
  user?: string
}

/**
 * OpenAI-compatible image edit request payload.
 * The `image` field can be a single image or `images` can be an array.
 */
export interface ImageEditRequest {
  model: string
  prompt: string
  image?: { type: string; url: string }
  images?: Array<{ type: string; url: string }>
  n?: number
  size?: string
  response_format?: "b64_json" | "url"
  user?: string
}

export interface ImageGenerationResponse {
  created: number
  data: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
  }>
}

/** Map OpenAI `size` (e.g. "1024x1024") to xAI `aspect_ratio` + `resolution`. */
function mapSizeToAspectRatio(size: string | undefined): {
  aspect_ratio: string
  resolution: string
} {
  if (!size) return { aspect_ratio: "1:1", resolution: "1k" }
  const lower = size.toLowerCase()
  if (lower.includes("2048")) return { aspect_ratio: "1:1", resolution: "2k" }
  const map: Record<string, string> = {
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
    "1536x1024": "3:2",
    "1024x1536": "2:3",
  }
  return {
    aspect_ratio: map[lower] ?? "1:1",
    resolution: lower.includes("2048") ? "2k" : "1k",
  }
}

function resolveBaseUrl(connection: ProviderConnection): string {
  const settingsBase = getConnectionSettings(connection)?.baseUrl
  return (
    typeof settingsBase === "string" ? settingsBase : XAI_API_BASE_URL).replace(
    /\/+$/,
    "",
  )
}

/**
 * Create an image generation via xAI's `/images/generations` endpoint.
 * Translates the OpenAI-compatible payload to xAI's format.
 */
export async function createXaiImageGeneration(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  payload: ImageGenerationRequest,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<ImageGenerationResponse> {
  if (connection.protocol !== "xai-native") {
    throw new Error("xAI image generation requires an xAI OAuth connection")
  }

  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `xAI access token missing for connection "${connection.name}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const baseUrl = resolveBaseUrl(connection)
  const url = `${baseUrl}/images/generations`
  const { aspect_ratio, resolution } = mapSizeToAspectRatio(payload.size)

  const upstreamBody = {
    model,
    prompt: payload.prompt,
    response_format: payload.response_format ?? "b64_json",
    aspect_ratio,
    resolution,
    n: payload.n ?? 1,
  }

  const headers = buildXaiHeaders(accessToken, false)
  if (idempotencyKey) {
    headers["x-idempotency-key"] = idempotencyKey
  }

  const response = await fetchWithConnectionProxy(connection, url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal,
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "(unreadable)")
    logger.warn(
      `xAI image generation failed for connection "${connection.name}" model "${model}": ${response.status} ${response.statusText}`,
    )
    throw new HTTPError(
      "Failed to create xAI image generation",
      response,
      bodyText,
    )
  }

  return (await response.json()) as ImageGenerationResponse
}

/**
 * Edit an image via xAI's `/images/edits` endpoint.
 * Translates the OpenAI-compatible payload to xAI's format.
 */
export async function createXaiImageEdit(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  payload: ImageEditRequest,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<ImageGenerationResponse> {
  if (connection.protocol !== "xai-native") {
    throw new Error("xAI image edit requires an xAI OAuth connection")
  }

  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `xAI access token missing for connection "${connection.name}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const baseUrl = resolveBaseUrl(connection)
  const url = `${baseUrl}/images/edits`
  const { aspect_ratio, resolution } = mapSizeToAspectRatio(payload.size)

  const upstreamBody: Record<string, unknown> = {
    model,
    prompt: payload.prompt,
    response_format: payload.response_format ?? "b64_json",
    aspect_ratio,
    resolution,
    n: payload.n ?? 1,
  }

  // xAI accepts either `image` (single) or `images` (array)
  if (payload.images && payload.images.length > 0) {
    upstreamBody.images = payload.images
  } else if (payload.image) {
    upstreamBody.image = payload.image
  }

  const headers = buildXaiHeaders(accessToken, false)
  if (idempotencyKey) {
    headers["x-idempotency-key"] = idempotencyKey
  }

  const response = await fetchWithConnectionProxy(connection, url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal,
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "(unreadable)")
    logger.warn(
      `xAI image edit failed for connection "${connection.name}" model "${model}": ${response.status} ${response.statusText}`,
    )
    throw new HTTPError("Failed to create xAI image edit", response, bodyText)
  }

  return (await response.json()) as ImageGenerationResponse
}
