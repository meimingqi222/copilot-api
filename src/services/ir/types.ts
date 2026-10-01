/** The IR is used only when translating between public wire protocols. */
export type IRWire = "chat" | "messages" | "responses" | "gemini"

export interface IRSource {
  wire: IRWire
  /** The issuer matters for opaque signatures, encrypted reasoning and file IDs. */
  issuer?: string
  providerId?: string
  model?: string
}

interface IRCacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

export interface IRTextPart {
  type: "text"
  text: string
  id?: string
  cacheControl?: IRCacheControl
}

type IRImageSource =
  | { type: "url"; url: string; detail?: "low" | "high" | "auto" }
  | { type: "base64"; mediaType: string; data: string }

export interface IRImagePart {
  type: "image"
  source: IRImageSource
  id?: string
}

type IRFileSource =
  | { type: "url"; url: string }
  | { type: "base64"; data: string; mediaType: string; name?: string }
  | { type: "file_id"; fileId: string; issuer?: string }

interface IRFilePart {
  type: "file"
  source: IRFileSource
  id?: string
}

/** A signature is replayable only with unchanged text to its issuer. */
export interface IRThinkingPart {
  type: "thinking"
  text: string
  id?: string
  signature?: string
  signedText?: string
  encryptedContent?: string
  source: IRSource
}

export interface IRToolCallPart {
  type: "tool_call"
  id: string
  name: string
  arguments: string
  namespace?: string
  originalName?: string
}

export type IRToolResultContent = IRTextPart | IRImagePart | IRFilePart

export interface IRToolResultPart {
  type: "tool_result"
  callId: string
  content: Array<IRToolResultContent>
  isError?: boolean
  id?: string
}

/**
 * A tool the *upstream* ran on the caller's behalf (Anthropic
 * `server_tool_use`, OpenAI `web_search_call`). Distinct from `tool_call`,
 * which the client is expected to execute and answer with a `tool_result`.
 */
interface IRServerToolUsePart {
  type: "server_tool_use"
  id: string
  /** Server tool name, e.g. `web_search`. */
  name: string
  /** Raw JSON arguments, kept as text so an unknown shape still round-trips. */
  input: string
}

export interface IRWebSearchResult {
  url: string
  title?: string
  pageAge?: string
  encryptedContent?: string
}

/** The results the upstream search returned for one `server_tool_use`. */
export interface IRWebSearchResultPart {
  type: "web_search_result"
  toolUseId: string
  results: Array<IRWebSearchResult>
}

export type IRPart =
  | IRTextPart
  | IRImagePart
  | IRFilePart
  | IRThinkingPart
  | IRToolCallPart
  | IRToolResultPart
  | IRServerToolUsePart
  | IRWebSearchResultPart

interface IRInstruction {
  role: "system" | "developer"
  parts: Array<IRTextPart>
  source?: IRSource
}

export interface IRTurn {
  role: "user" | "assistant" | "tool"
  parts: Array<IRPart>
  source?: IRSource
}

export interface IRTool {
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
  namespace?: string
  originalName?: string
}

export type IRToolChoice =
  | { type: "auto" | "none" | "required" }
  | { type: "tool"; name: string }
  | { type: "allowed"; mode: "auto" | "required"; names: Array<string> }

interface IRReasoningOptions {
  mode?: "enabled" | "disabled" | "adaptive"
  effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "auto"
  budgetTokens?: number
  display?: "summarized" | "omitted"
  summary?: "auto" | "concise" | "detailed"
}

type IRTextFormat =
  | { type: "text" | "json_object" }
  | { type: "json_schema"; jsonSchema: Record<string, unknown> }

/** Declaration of a server-side web search tool, when the client sent one. */
export interface IRWebSearchOptions {
  /** Wire-specific tool type, e.g. `web_search_20250305` or `web_search`. */
  wireType?: string
  maxUses?: number
  allowedDomains?: Array<string>
  blockedDomains?: Array<string>
}

export interface IRGenerationOptions {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: Array<string>
  parallelToolCalls?: boolean
  maxToolCalls?: number
  reasoning?: IRReasoningOptions
  textFormat?: IRTextFormat
  serviceTier?: "auto" | "standard_only"
  store?: boolean
  background?: boolean
  previousResponseId?: string
  truncation?: "auto" | "disabled"
  metadata?: Record<string, unknown>
  user?: string
  /**
   * The caller asked for upstream-side web search. The proxy does not
   * orchestrate a search loop; the intent is only carried to targets that
   * implement it natively, and rejected when none does.
   */
  webSearch?: boolean
  webSearchOptions?: IRWebSearchOptions
}

export interface RequestIR {
  model: string
  source: IRSource
  instructions: Array<IRInstruction>
  turns: Array<IRTurn>
  tools?: Array<IRTool>
  toolChoice?: IRToolChoice
  generation?: IRGenerationOptions
}

export interface IRUsage {
  source: "reported" | "estimated" | "mixed"
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  /** Source fields may be retained for diagnostics, never used as normalized counts. */
  raw?: Record<string, unknown>
}

export interface IRStop {
  reason:
    | "complete"
    | "max_tokens"
    | "tool_calls"
    | "stop_sequence"
    | "refusal"
    | "pause"
    | "error"
    | "incomplete"
    | "unknown"
  raw?: string
}

export interface ResultIR {
  id: string
  model: string
  source: IRSource
  parts: Array<IRPart>
  stop?: IRStop
  usage?: IRUsage
  status?: "completed" | "incomplete" | "failed"
  error?: { type: string; message: string; status?: number }
  createdAt?: number
}

export type IRPartDelta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "signature"; text: string }
  | { type: "tool_arguments"; text: string }

/** A stream is consumed incrementally; `index` identifies a content block. */
export type StreamEvent =
  | {
      type: "message_start"
      id: string
      model: string
      source: IRSource
      createdAt?: number
    }
  | { type: "part_start"; partId: string; index: number; part: IRPart }
  | { type: "part_delta"; partId: string; index: number; delta: IRPartDelta }
  | { type: "part_end"; partId: string; index: number }
  | { type: "usage"; usage: IRUsage }
  | { type: "message_end"; stop?: IRStop; status?: ResultIR["status"] }
  | { type: "error"; error: { type: string; message: string; status?: number } }

export type LossAction =
  | "preserve"
  | "transform"
  | "synthesize"
  | "drop"
  | "reject"
export type LossStage =
  | "decode"
  | "preflight"
  | "encode_request"
  | "decode_response"
  | "encode_response"

/** Loss records contain metadata only: never prompt content, image bytes, signatures or ciphertext. */
export interface LossRecord {
  path: string
  feature: string
  action: LossAction
  reason: string
  target: IRWire
  stage: LossStage
}

export interface LossReport {
  records: Array<LossRecord>
}

export interface ConversionPlan {
  accepted: boolean
  source: IRWire
  target: IRWire
  losses: LossReport
}
