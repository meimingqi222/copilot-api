import {
  readAnthropicServiceTier,
  readOpenAIServiceTier,
} from "~/lib/service-tier"

import type {
  ConversionPlan,
  IRPart,
  IRSource,
  IRToolChoice,
  IRWire,
  LossAction,
  LossRecord,
  RequestIR,
} from "./types"

type RequestFeatureKind =
  | "image"
  | "tool_result_image"
  | "file"
  | "file_id"
  | "signed_thinking"
  | "unsigned_thinking"
  | "encrypted_reasoning"
  | "cache_control"
  | "namespace_tool"
  | "allowed_tools"
  | "web_search"
  | "server_tool_use"
  | "web_search_result"
  | "reasoning_effort"
  | "service_tier"

interface RequestFeature {
  kind: RequestFeatureKind
  path: string
  /** Current turn contents can affect the answer and are never silently dropped. */
  current: boolean
  source?: IRSource
  /** False means the thinking text changed after its signature was issued. */
  replayable?: boolean
}

/** Wire support is a baseline; connection/model overrides belong in TargetCapabilities. */
interface WireCapabilities {
  images: boolean
  toolResultImages: boolean
  files: boolean
  fileIds: boolean
  signedThinking: boolean
  encryptedReasoning: boolean
  cacheControl: boolean
  namespaceTools: boolean
  allowedTools: boolean
  webSearch: boolean
  /** Can carry an upstream-executed tool call in the transcript. */
  serverToolUse: boolean
  /** Can carry `web_search` results back in the transcript. */
  webSearchResults: boolean
}

export const WIRE_CAPABILITIES: Readonly<
  Record<IRWire, Readonly<WireCapabilities>>
> = {
  chat: {
    images: true,
    toolResultImages: true,
    files: false,
    fileIds: false,
    signedThinking: false,
    encryptedReasoning: false,
    cacheControl: false,
    namespaceTools: false,
    allowedTools: false,
    webSearch: false,
    serverToolUse: false,
    webSearchResults: false,
  },
  messages: {
    images: true,
    toolResultImages: true,
    files: false,
    fileIds: false,
    signedThinking: true,
    encryptedReasoning: false,
    cacheControl: true,
    namespaceTools: false,
    allowedTools: false,
    // Anthropic's `web_search` server tool and its `server_tool_use` /
    // `web_search_tool_result` blocks are carried verbatim in both directions.
    webSearch: true,
    serverToolUse: true,
    webSearchResults: true,
  },
  responses: {
    images: true,
    toolResultImages: true,
    files: true,
    fileIds: true,
    signedThinking: false,
    encryptedReasoning: true,
    cacheControl: false,
    namespaceTools: true,
    allowedTools: true,
    // Responses declares search as a `web_search` tool and reports it as a
    // `web_search_call` item whose `action.sources` carries the visited URLs,
    // so the results survive without Anthropic's separate result block.
    webSearch: true,
    serverToolUse: true,
    webSearchResults: true,
  },
  // Gemini generateContent. `files` is false because portable file transport
  // (Files API upload) is not implemented — inlineData images and http(s)
  // fileData URLs are the supported carriers. Signatures are per-wire
  // (thoughtSignature), so replay is only valid for Gemini-sourced thinking.
  gemini: {
    images: true,
    toolResultImages: false,
    files: false,
    fileIds: false,
    signedThinking: true,
    encryptedReasoning: false,
    cacheControl: false,
    namespaceTools: false,
    allowedTools: true,
    // Grounding is requested with the `google_search` tool; Gemini reports it
    // as groundingMetadata, not as replayable transcript blocks.
    webSearch: true,
    serverToolUse: false,
    webSearchResults: false,
  },
}

interface TargetCapabilities {
  wire: IRWire
  providerId?: string
  model?: string
  /** Identity of the issuer that will validate opaque references. */
  issuer?: string
  supports?: Partial<WireCapabilities>
  /** A target may itself place prompt cache breakpoints. */
  cacheControlPolicy?: "caller" | "target"
  /**
   * The proxy can run the search itself (see `services/search/`), so a wire
   * that cannot carry search natively is still usable. Set by the caller after
   * checking that a searcher connection exists — `planTranslation` stays pure.
   */
  orchestratedWebSearch?: boolean
  acceptedEfforts?: ReadonlyArray<
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto"
  >
}

function scanPart(
  part: IRPart,
  path: string,
  current: boolean,
  result: Array<RequestFeature>,
): void {
  if (part.type === "image") {
    result.push({ kind: "image", path, current })
  } else if (part.type === "file") {
    result.push({ kind: "file", path, current })
    if (part.source.type === "file_id") {
      result.push({
        kind: "file_id",
        path,
        current,
        source: { wire: "responses", issuer: part.source.issuer },
      })
    }
  } else if (part.type === "thinking") {
    result.push({
      kind: part.signature ? "signed_thinking" : "unsigned_thinking",
      path,
      current,
      source: part.source,
      replayable:
        !part.signature
        || part.signedText === undefined
        || part.signedText === part.text,
    })
    if (part.encryptedContent) {
      result.push({
        kind: "encrypted_reasoning",
        path,
        current,
        source: part.source,
      })
    }
  } else if (part.type === "text" && part.cacheControl) {
    result.push({ kind: "cache_control", path, current })
  } else if (part.type === "tool_result") {
    part.content.forEach((content, index) => {
      const contentPath = `${path}.content[${index}]`
      if (content.type === "image") {
        result.push({ kind: "tool_result_image", path: contentPath, current })
      } else {
        scanPart(content, contentPath, current, result)
      }
    })
  } else if (part.type === "server_tool_use") {
    result.push({ kind: "server_tool_use", path, current })
  } else if (part.type === "web_search_result") {
    result.push({ kind: "web_search_result", path, current })
  }
}

export function inspectRequestFeatures(
  request: RequestIR,
): Array<RequestFeature> {
  const features: Array<RequestFeature> = []
  request.instructions.forEach((instruction, index) => {
    instruction.parts.forEach((part, partIndex) => {
      scanPart(
        part,
        `instructions[${index}].parts[${partIndex}]`,
        false,
        features,
      )
    })
  })
  const currentTurnIndex = request.turns.length - 1
  request.turns.forEach((turn, turnIndex) => {
    turn.parts.forEach((part, partIndex) => {
      scanPart(
        part,
        `turns[${turnIndex}].parts[${partIndex}]`,
        turnIndex === currentTurnIndex,
        features,
      )
    })
  })
  request.tools?.forEach((tool, index) => {
    if (tool.namespace) {
      features.push({
        kind: "namespace_tool",
        path: `tools[${index}]`,
        current: true,
      })
    }
  })
  if (request.toolChoice?.type === "allowed") {
    features.push({ kind: "allowed_tools", path: "toolChoice", current: true })
  }
  if (request.generation?.webSearch) {
    features.push({
      kind: "web_search",
      path: "generation.webSearch",
      current: true,
    })
  }
  if (request.generation?.reasoning?.effort) {
    features.push({
      kind: "reasoning_effort",
      path: "generation.reasoning.effort",
      current: true,
    })
  }
  if (request.generation?.serviceTier) {
    features.push({
      kind: "service_tier",
      path: "generation.serviceTier",
      current: true,
    })
  }
  return features
}

function record(
  records: Array<LossRecord>,
  target: IRWire,
  feature: RequestFeature,
  action: LossAction,
  reason: string,
): void {
  if (action === "preserve") return
  records.push({
    path: feature.path,
    feature: feature.kind,
    action,
    reason,
    target,
    stage: "preflight",
  })
}

function validateAllowedTools(
  choice: IRToolChoice | undefined,
  request: RequestIR,
): string | undefined {
  if (!choice || choice.type !== "allowed") return undefined
  const declared = new Set(request.tools?.map((tool) => tool.name) ?? [])
  if (choice.names.some((name) => !declared.has(name))) {
    return "allowed_tools names an undeclared tool"
  }
  if (choice.mode === "required" && choice.names.length === 0) {
    return "required allowed_tools set is empty"
  }
  return undefined
}

/** Plans semantic handling before an upstream request is sent. */
export function planTranslation(
  request: RequestIR,
  target: TargetCapabilities,
): ConversionPlan {
  const capabilities = { ...WIRE_CAPABILITIES[target.wire], ...target.supports }
  const records: Array<LossRecord> = []
  const features = inspectRequestFeatures(request)
  const allowedError = validateAllowedTools(request.toolChoice, request)
  if (allowedError) {
    record(
      records,
      target.wire,
      { kind: "allowed_tools", path: "toolChoice", current: true },
      "reject",
      allowedError,
    )
  }

  const declaredNames = new Set<string>()
  request.tools?.forEach((tool, index) => {
    // Codecs normalize namespace names into `tool.name` and retain the
    // original name for the reverse mapping. Check the actual outgoing name.
    const targetName =
      capabilities.namespaceTools ?
        `${tool.namespace ?? ""}\0${tool.originalName ?? tool.name}`
      : tool.name
    if (declaredNames.has(targetName)) {
      record(
        records,
        target.wire,
        { kind: "namespace_tool", path: `tools[${index}]`, current: true },
        "reject",
        "tool names collide after target mapping",
      )
    }
    declaredNames.add(targetName)
  })

  for (const feature of features)
    recordFeatureLoss(records, target, feature, request, capabilities)
  return {
    accepted: !records.some((entry) => entry.action === "reject"),
    source: request.source.wire,
    target: target.wire,
    losses: { records },
  }
}

/** Decides one feature's handling. Kept separate so the planning loop stays flat. */
function recordFeatureLoss(
  records: Array<LossRecord>,
  target: TargetCapabilities,
  feature: RequestFeature,
  request: RequestIR,
  capabilities: WireCapabilities,
): void {
  switch (feature.kind) {
    case "service_tier": {
      const tier = request.generation?.serviceTier
      const supported =
        (target.wire === "messages" && readAnthropicServiceTier(tier))
        || ((target.wire === "chat" || target.wire === "responses")
          && readOpenAIServiceTier(tier))
      if (!supported) {
        record(
          records,
          target.wire,
          feature,
          "drop",
          "target wire cannot express the requested service tier",
        )
      }
      break
    }
    case "image":
    case "tool_result_image":
    case "file":
    case "file_id":
      recordMediaLoss(records, target, feature, capabilities)
      break
    case "signed_thinking":
    case "unsigned_thinking":
    case "encrypted_reasoning":
    case "cache_control":
      recordReasoningLoss(records, target, feature, capabilities)
      break
    case "namespace_tool":
    case "allowed_tools":
    case "web_search":
    case "server_tool_use":
    case "web_search_result":
      recordToolLoss(records, target, feature, request, capabilities)
      break
    case "reasoning_effort":
      recordEffortLoss(records, target, feature, request)
      break
  }
}

type MediaFeatureKind = "image" | "tool_result_image" | "file" | "file_id"
type ReasoningFeatureKind =
  | "signed_thinking"
  | "unsigned_thinking"
  | "encrypted_reasoning"
  | "cache_control"
type ToolFeatureKind =
  | "namespace_tool"
  | "allowed_tools"
  | "web_search"
  | "server_tool_use"
  | "web_search_result"

function recordMediaLoss(
  records: Array<LossRecord>,
  target: TargetCapabilities,
  feature: RequestFeature,
  capabilities: WireCapabilities,
): void {
  switch (feature.kind as MediaFeatureKind) {
    case "image":
      if (!capabilities.images)
        record(
          records,
          target.wire,
          feature,
          "reject",
          "target cannot receive images",
        )
      break
    case "tool_result_image":
      if (!capabilities.toolResultImages || !capabilities.images) {
        record(
          records,
          target.wire,
          feature,
          "reject",
          "target cannot receive tool-result images",
        )
      } else if (target.wire === "chat") {
        record(
          records,
          target.wire,
          feature,
          "transform",
          "move image to the following user content while retaining call order",
        )
      }
      break
    case "file":
      if (!capabilities.files) {
        record(
          records,
          target.wire,
          feature,
          "reject",
          "target cannot receive file content",
        )
      }
      break
    case "file_id":
      if (
        !capabilities.fileIds
        || !target.issuer
        || target.issuer !== feature.source?.issuer
      ) {
        record(
          records,
          target.wire,
          feature,
          "reject",
          "file ID cannot be resolved by this target",
        )
      }
      break
  }
}

function recordReasoningLoss(
  records: Array<LossRecord>,
  target: TargetCapabilities,
  feature: RequestFeature,
  capabilities: WireCapabilities,
): void {
  switch (feature.kind as ReasoningFeatureKind) {
    case "signed_thinking":
      if (
        target.wire === "gemini"
        && feature.source?.wire !== "gemini"
        && capabilities.signedThinking
      ) {
        record(
          records,
          target.wire,
          feature,
          "drop",
          "signature is not valid for the target wire",
        )
      } else if (target.wire === "messages" || target.wire === "gemini") {
        if (feature.replayable === false) {
          record(
            records,
            target.wire,
            feature,
            "drop",
            "thinking text changed after signing",
          )
        } else if (
          target.issuer
          && feature.source?.issuer
          && target.issuer !== feature.source.issuer
        ) {
          record(
            records,
            target.wire,
            feature,
            "drop",
            "thinking signature belongs to another issuer",
          )
        }
      } else {
        record(
          records,
          target.wire,
          feature,
          "transform",
          "target cannot replay Anthropic signature; retain readable reasoning only",
        )
      }
      break
    case "unsigned_thinking":
      if (target.wire === "messages" || target.wire === "gemini") {
        record(
          records,
          target.wire,
          feature,
          "drop",
          "historical thinking without a valid signature cannot be replayed",
        )
      }
      break
    case "encrypted_reasoning":
      if (
        !capabilities.encryptedReasoning
        || !target.issuer
        || target.issuer !== feature.source?.issuer
      ) {
        record(
          records,
          target.wire,
          feature,
          "drop",
          "opaque reasoning cannot be replayed to another issuer",
        )
      }
      break
    case "cache_control":
      if (
        !capabilities.cacheControl
        && target.cacheControlPolicy !== "target"
      ) {
        record(
          records,
          target.wire,
          feature,
          "drop",
          "target has no explicit cache breakpoint",
        )
      } else if (target.cacheControlPolicy === "target") {
        record(
          records,
          target.wire,
          feature,
          "transform",
          "target places its own cache breakpoints",
        )
      }
      break
  }
}

function recordToolLoss(
  records: Array<LossRecord>,
  target: TargetCapabilities,
  feature: RequestFeature,
  request: RequestIR,
  capabilities: WireCapabilities,
): void {
  switch (feature.kind as ToolFeatureKind) {
    case "namespace_tool":
      if (!capabilities.namespaceTools) {
        record(
          records,
          target.wire,
          feature,
          "transform",
          "flatten namespace with a reversible request-level mapping",
        )
      }
      break
    case "allowed_tools":
      if (
        !capabilities.allowedTools
        && request.toolChoice?.type === "allowed"
      ) {
        record(
          records,
          target.wire,
          feature,
          target.wire === "chat" ? "transform" : "reject",
          target.wire === "chat" ?
            "filter declarations before applying target tool choice"
          : "target cannot enforce allowed tool subset",
        )
      }
      break
    case "web_search":
      if (!capabilities.webSearch) {
        if (target.orchestratedWebSearch) {
          record(
            records,
            target.wire,
            feature,
            "transform",
            "proxy runs the search loop against a search-capable account",
          )
        } else {
          record(
            records,
            target.wire,
            feature,
            "reject",
            "target has no native or orchestrated web search",
          )
        }
      }
      break
    case "server_tool_use":
      if (!capabilities.serverToolUse) {
        // Replaying an upstream-executed search is only possible where the
        // wire models it. History may be dropped; the current turn is the
        // caller asking for a fresh search, so it must not be.
        record(
          records,
          target.wire,
          feature,
          feature.current ? "reject" : "drop",
          feature.current ?
            "target cannot perform a server-side tool call"
          : "historical server tool call cannot be replayed to this target",
        )
      }
      break
    case "web_search_result":
      if (!capabilities.webSearchResults) {
        record(
          records,
          target.wire,
          feature,
          feature.current ? "reject" : "drop",
          feature.current ?
            "target cannot receive web search results"
          : "historical web search results cannot be replayed to this target",
        )
      }
      break
  }
}

function recordEffortLoss(
  records: Array<LossRecord>,
  target: TargetCapabilities,
  feature: RequestFeature,
  request: RequestIR,
): void {
  const effort = request.generation?.reasoning?.effort
  if (
    effort
    && target.acceptedEfforts
    && !target.acceptedEfforts.includes(effort)
  ) {
    record(
      records,
      target.wire,
      feature,
      "reject",
      "requested reasoning effort is unsupported by target model",
    )
    return
  }
  if (target.wire === "messages") {
    if (effort === "minimal" || effort === "xhigh" || effort === "max") {
      record(
        records,
        target.wire,
        feature,
        "transform",
        "reasoning effort mapped to nearest Messages level",
      )
    } else if (effort === "none" || effort === "auto") {
      record(
        records,
        target.wire,
        feature,
        "transform",
        "reasoning effort represented by omitted Messages thinking config",
      )
    }
  } else if (
    target.wire === "responses"
    && effort
    && !["low", "medium", "high"].includes(effort)
  ) {
    record(
      records,
      target.wire,
      feature,
      "reject",
      "Responses target cannot express requested reasoning effort",
    )
  }
}
