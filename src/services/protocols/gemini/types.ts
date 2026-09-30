/**
 * Gemini `generateContent` wire types.
 *
 * These describe the public client wire (`POST /v1beta/models/{model}:generateContent`)
 * and the upstream request/response shape. Translation to and from the shared
 * IR lives in `~/services/ir/codecs/gemini`; this module is types only.
 *
 * Reference: https://ai.google.dev/api/generate-content
 */

export interface GeminiInlineData {
  mimeType: string
  data: string
}

export interface GeminiFileData {
  mimeType?: string
  fileUri?: string
}

export interface GeminiFunctionCall {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export interface GeminiFunctionResponse {
  id?: string
  name: string
  response: Record<string, unknown>
}

export interface GeminiPart {
  text?: string
  /** Marks a part as model reasoning produced by a thinking model. */
  thought?: boolean
  /** Opaque signature Gemini issues for a thought part; required on replay. */
  thoughtSignature?: string
  inlineData?: GeminiInlineData
  fileData?: GeminiFileData
  functionCall?: GeminiFunctionCall
  functionResponse?: GeminiFunctionResponse
}

export interface GeminiContent {
  role?: "user" | "model"
  parts: Array<GeminiPart>
}

export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface GeminiTool {
  functionDeclarations?: Array<GeminiFunctionDeclaration>
  /** Native Google Search grounding; the wire carries it as an empty object. */
  google_search?: Record<string, never>
  /** Some clients spell it snake_case; accepted on decode only. */
  googleSearch?: Record<string, never>
}

export interface GeminiToolConfig {
  functionCallingConfig: {
    mode: "AUTO" | "ANY" | "NONE"
    allowedFunctionNames?: Array<string>
  }
}

export interface GeminiThinkingConfig {
  thinkingBudget?: number
  thinkingLevel?: string
  includeThoughts?: boolean
}

export interface GeminiGenerationConfig {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: Array<string>
  thinkingConfig?: GeminiThinkingConfig
}

export interface GeminiGenerateContentRequest {
  /** Filled from the URL path; not part of the client body. */
  model?: string
  contents: Array<GeminiContent>
  systemInstruction?: { role?: string; parts: Array<GeminiPart> }
  tools?: Array<GeminiTool>
  toolConfig?: GeminiToolConfig
  generationConfig?: GeminiGenerationConfig
  /** Set by the route/adapter; not part of the client body. */
  stream?: boolean
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

export interface GeminiCandidate {
  content?: GeminiContent
  finishReason?: string
  index?: number
}

export interface GeminiPromptFeedback {
  blockReason?: string
  blockReasonMessage?: string
}

export interface GeminiGenerateContentResponse {
  candidates?: Array<GeminiCandidate>
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
  responseId?: string
  promptFeedback?: GeminiPromptFeedback
}

/** One SSE frame of `:streamGenerateContent?alt=sse`. */
export interface GeminiStreamEvent {
  data?: string
  event?: string
}
