import consola from "consola"

import type { Account, OAuthAccount } from "~/lib/accounts"

import { canonicalNativeModelId, isOAuthAccount } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import { XAI_API_BASE_URL } from "~/services/oauth/xai"

import { buildXaiHeaders } from "./headers"

/**
 * OpenAI-compatible video generation request payload.
 */
export interface VideoGenerationRequest {
  model: string
  prompt: string
  seconds?: string | number
  size?: string
  image?: { url: string }
  reference_images?: Array<{ url: string }>
  user?: string
}

/** xAI raw response from POST /videos/generations */
interface XaiVideoCreateResponse {
  request_id: string
}

/** xAI raw response from GET /videos/{request_id} */
interface XaiVideoStatusResponse {
  status: string
  progress?: number
  model?: string
  video?: {
    url: string
    duration?: number
  }
  error?: string
}

/** OpenAI-compatible video creation response */
export interface VideoCreationResponse {
  object: "video"
  id: string
  model: string
  prompt: string
  seconds: string
  size: string
  created_at: number
  progress: number
  status: "queued" | "in_progress" | "completed" | "failed"
}

/** OpenAI-compatible video retrieval response */
export interface VideoRetrieveResponse {
  object: "video"
  id: string
  model: string
  status: "queued" | "in_progress" | "completed" | "failed"
  progress: number
  seconds?: number
  video_url?: string
  created_at?: number
  completed_at?: number
  error?: string
}

/** Map xAI status string to OpenAI-compatible status. */
function mapVideoStatus(
  status: string,
): "queued" | "in_progress" | "completed" | "failed" {
  const s = status.toLowerCase()
  if (s === "queued" || s === "pending") return "queued"
  if (s === "in_progress" || s === "processing" || s === "running") {
    return "in_progress"
  }
  if (
    s === "completed"
    || s === "done"
    || s === "succeeded"
    || s === "success"
  ) {
    return "completed"
  }
  return "failed"
}

/** Map OpenAI `size` (e.g. "720x1280") to xAI `aspect_ratio` + `resolution`. */
function mapVideoSize(size: string | undefined): {
  aspect_ratio: string
  resolution: string
} {
  if (!size) return { aspect_ratio: "16:9", resolution: "720p" }
  const lower = size.toLowerCase()
  const map: Record<string, { aspect_ratio: string; resolution: string }> = {
    "720x1280": { aspect_ratio: "9:16", resolution: "720p" },
    "1280x720": { aspect_ratio: "16:9", resolution: "720p" },
    "1024x1792": { aspect_ratio: "9:16", resolution: "720p" },
    "1792x1024": { aspect_ratio: "16:9", resolution: "720p" },
  }
  return map[lower] ?? { aspect_ratio: "16:9", resolution: "720p" }
}

function resolveBaseUrl(account: OAuthAccount): string {
  return (account.settings?.baseUrl ?? XAI_API_BASE_URL).replace(/\/+$/, "")
}

function parseDuration(seconds: string | number | undefined): number {
  const n =
    typeof seconds === "number" ? seconds : Number.parseInt(String(seconds), 10)
  if (Number.isNaN(n) || n < 1) return 4
  return Math.min(Math.max(n, 1), 15)
}

/**
 * Create a video generation via xAI's `/videos/generations` endpoint.
 * Returns a request_id that can be polled via `retrieveXaiVideo`.
 */
export async function createXaiVideoGeneration(
  account: Account,
  payload: VideoGenerationRequest,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<VideoCreationResponse> {
  if (!isOAuthAccount(account) || account.provider !== "xai") {
    throw new Error("xAI video generation requires an xAI OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(`xAI access token missing for account "${account.label}"`)
  }

  const model = canonicalNativeModelId(payload.model)
  const baseUrl = resolveBaseUrl(account)
  const url = `${baseUrl}/videos/generations`
  const { aspect_ratio, resolution } = mapVideoSize(payload.size)
  let duration = parseDuration(payload.seconds)

  // When reference_images are provided, duration is capped at 10
  if (
    payload.reference_images
    && payload.reference_images.length > 0
    && duration > 10
  ) {
    duration = 10
  }

  const upstreamBody: Record<string, unknown> = {
    model,
    prompt: payload.prompt,
    duration,
    aspect_ratio,
    resolution,
  }

  if (payload.image?.url) {
    upstreamBody.image = payload.image
  }
  if (payload.reference_images && payload.reference_images.length > 0) {
    upstreamBody.reference_images = payload.reference_images
  }

  const headers = buildXaiHeaders(accessToken, false)
  if (idempotencyKey) {
    headers["x-idempotency-key"] = idempotencyKey
  }

  const response = await fetchWithOAuthProxy(account, url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal,
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "(unreadable)")
    consola.warn(
      `xAI video generation failed for account "${account.label}" model "${model}": ${response.status} ${response.statusText}`,
    )
    throw new HTTPError(
      "Failed to create xAI video generation",
      response,
      bodyText,
    )
  }

  const xaiResp = (await response.json()) as XaiVideoCreateResponse
  return {
    object: "video",
    id: xaiResp.request_id,
    model,
    prompt: payload.prompt,
    seconds: String(duration),
    size: payload.size ?? "1280x720",
    created_at: Math.floor(Date.now() / 1000),
    progress: 0,
    status: "queued",
  }
}

/**
 * Retrieve the status of a video generation via xAI's
 * `GET /videos/{request_id}` endpoint.
 */
export async function retrieveXaiVideo(
  account: Account,
  requestId: string,
  signal?: AbortSignal,
): Promise<VideoRetrieveResponse> {
  if (!isOAuthAccount(account) || account.provider !== "xai") {
    throw new Error("xAI video retrieval requires an xAI OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(`xAI access token missing for account "${account.label}"`)
  }

  const baseUrl = resolveBaseUrl(account)
  const url = `${baseUrl}/videos/${encodeURIComponent(requestId)}`

  const response = await fetchWithOAuthProxy(account, url, {
    method: "GET",
    headers: buildXaiHeaders(accessToken, false),
    signal,
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "(unreadable)")
    consola.warn(
      `xAI video retrieval failed for account "${account.label}" request "${requestId}": ${response.status} ${response.statusText}`,
    )
    throw new HTTPError(
      "Failed to retrieve xAI video status",
      response,
      bodyText,
    )
  }

  const xaiResp = (await response.json()) as XaiVideoStatusResponse
  const status = mapVideoStatus(xaiResp.status)
  const result: VideoRetrieveResponse = {
    object: "video",
    id: requestId,
    model: xaiResp.model ?? "",
    status,
    progress: xaiResp.progress ?? 0,
  }

  if (xaiResp.video?.url) {
    result.video_url = xaiResp.video.url
  }
  if (xaiResp.video?.duration !== undefined) {
    result.seconds = xaiResp.video.duration
  }
  if (status === "completed") {
    result.completed_at = Math.floor(Date.now() / 1000)
  }
  if (xaiResp.error) {
    result.error = xaiResp.error
  }

  return result
}
