import type { Context } from "hono"

import { asRecord } from "~/lib/json-shape"

/**
 * Normalizes common variations into clean, recognizable Agent display names.
 */
function normalizeClientName(raw: string): string {
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  if (lower === "opencode" || lower === "open-code") return "OpenCode"
  if (
    lower === "claudecode"
    || lower === "claude-code"
    || lower === "claude_code"
  )
    return "Claude Code"
  if (lower === "cursor") return "Cursor"
  if (lower === "windsurf" || lower === "codeium") return "Windsurf"
  if (lower === "codex" || lower === "codex-cli" || lower === "codex_cli")
    return "Codex"
  if (lower === "cline") return "Cline"
  if (lower === "roocode" || lower === "roo-code") return "Roo Code"
  if (lower === "kilocode" || lower === "kilo-code" || lower === "kilo")
    return "Kilo Code"
  if (lower === "aider") return "Aider"
  if (lower === "continue") return "Continue"
  if (lower === "devin") return "Devin"
  if (lower === "zed") return "Zed"
  if (lower === "antigravity" || lower === "agy") return "Antigravity"
  if (lower === "dsh" || lower === "deepseek-harness") return "DSH"
  if (lower === "commandcode" || lower === "command-code") return "Command Code"
  if (lower === "pi" || lower === "oh-my-pi") return "Pi"
  if (lower === "qoder") return "Qoder"
  if (lower === "grok") return "Grok"
  if (lower === "amp" || lower === "amp-cli") return "Amp"
  if (lower === "zcode") return "ZCode"
  if (lower === "workbuddy") return "Workbuddy"
  if (lower === "codebuddy") return "Codebuddy"
  return trimmed.slice(0, 32)
}

function matchHeaderAgent(c: Context | undefined): string | undefined {
  if (!c) return undefined
  if (
    c.req.header("x-opencode-client")
    || c.req.header("x-opencode-session")
    || c.req.header("x-opencode-project")
    || c.req.header("x-opencode-request")
  ) {
    return "OpenCode"
  }
  if (c.req.header("x-claude-code-session-id")) return "Claude Code"
  // Amp stamps every call with these; without them its `Amp-CLI/<build>`
  // user agent fell through to the payload scan below.
  if (
    c.req.header("x-amp-client-type")
    || c.req.header("x-amp-installation-id")
  ) {
    return "Amp"
  }

  const explicitName =
    c.req.header("x-client-name")
    || c.req.header("x-client")
    || c.req.header("x-app-name")
    || c.req.header("x-agent-name")
    || c.req.header("x-agent")
  if (explicitName?.trim()) return normalizeClientName(explicitName)

  const title = c.req.header("x-title")
  if (title) {
    if (/opencode/i.test(title)) return "OpenCode"
    if (/aider/i.test(title)) return "Aider"
    if (/cline/i.test(title)) return "Cline"
    if (/cursor/i.test(title)) return "Cursor"
  }
  return undefined
}

const KNOWN_AGENTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "Claude Code", pattern: /claude[- ]?code|claude-cli/i },
  { name: "OpenCode", pattern: /open[- ]?code/i },
  { name: "Cursor", pattern: /cursor/i },
  { name: "Codex", pattern: /codex(?:_cli)?/i },
  { name: "Windsurf", pattern: /windsurf|codeium/i },
  { name: "Cline", pattern: /\bcline\b/i },
  { name: "Roo Code", pattern: /roo[- ]?code/i },
  { name: "Kilo Code", pattern: /kilo[- ]?code|\bkilo\b/i },
  { name: "Aider", pattern: /\baider\b/i },
  { name: "Continue", pattern: /continue(?:\.dev)?/i },
  { name: "Devin", pattern: /\bdevin\b/i },
  { name: "Zed", pattern: /zed(?:-editor)?/i },
  { name: "Antigravity", pattern: /antigravity|\bagy\b/i },
  { name: "DSH", pattern: /deepseek[- ]?harness|\bdsh\b/i },
  { name: "Command Code", pattern: /command[- ]?code/i },
  { name: "Pi", pattern: /oh-my-pi|pi-desktop|\bpi\b/i },
  { name: "Qoder", pattern: /qoder/i },
  { name: "Grok", pattern: /\bgrok\b|grok-pager/i },
  { name: "Amp", pattern: /^amp-cli\/|^amp\//i },
  { name: "ZCode", pattern: /zcode/i },
  { name: "Workbuddy", pattern: /workbuddy/i },
  { name: "Codebuddy", pattern: /codebuddy/i },
  { name: "StepCode", pattern: /stepcode/i },
  { name: "MimiCode", pattern: /mimocode/i },
  { name: "Deveco", pattern: /deveco/i },
  { name: "ZooCode", pattern: /zoo[- ]?code/i },
  { name: "Alma", pattern: /\balma\b/i },
  { name: "Cindy", pattern: /\bcindy\b/i },
  { name: "AionUI", pattern: /aionui/i },
  { name: "Chatbox", pattern: /chatbox/i },
  { name: "Cherry Studio", pattern: /cherry[- ]?studio/i },
  { name: "NextChat", pattern: /nextchat/i },
  { name: "LibreChat", pattern: /librechat/i },
  { name: "Dify", pattern: /\bdify\b/i },
  { name: "LangChain", pattern: /langchain/i },
  { name: "AutoGen", pattern: /autogen/i },
  { name: "CrewAI", pattern: /crewai/i },
  { name: "OpenHands", pattern: /openhands/i },
  {
    name: "VS Code / Copilot",
    pattern: /github[- ]?copilot|copilotchat|vscode|visual-studio-code/i,
  },
  { name: "curl", pattern: /^curl/i },
  { name: "Postman", pattern: /^postman/i },
]

function matchUserAgent(ua: string): string | undefined {
  for (const { name, pattern } of KNOWN_AGENTS) {
    if (pattern.test(ua)) return name
  }
  return undefined
}

/**
 * The system prompt is the one place a client names itself ("You are
 * OpenCode…"). Scanning the whole body would read the user's own words and
 * attribute a request to whichever tool the conversation happens to mention.
 */
function selfDescription(payload: unknown): string {
  if (typeof payload === "string") return payload
  const body = asRecord(payload)
  if (!body) return ""
  const system =
    Array.isArray(body.messages) ?
      body.messages
        .filter(
          (message) =>
            asRecord(message)?.role === "system"
            || asRecord(message)?.role === "developer",
        )
        .map((message) => textOf(asRecord(message)?.content))
        .join("\n")
    : ""
  return `${textOf(body.system)}\n${textOf(body.instructions)}\n${system}`
}

/** System fields arrive as a string, a text-part array, or nested blocks. */
function textOf(value: unknown, depth = 0): string {
  if (typeof value === "string") return value
  if (depth > 4 || !value) return ""
  if (Array.isArray(value))
    return value.map((item) => textOf(item, depth + 1)).join("\n")
  const record = asRecord(value)
  return record ? textOf(record.text ?? record.content, depth + 1) : ""
}

function matchPayloadAgent(payload: unknown): string | undefined {
  if (!payload) return undefined
  try {
    const prompt = selfDescription(payload)
    if (!prompt) return undefined
    if (/open[- ]?code/i.test(prompt)) return "OpenCode"
    if (/\baider\b/i.test(prompt)) return "Aider"
    if (/\bdevin\b/i.test(prompt)) return "Devin"
    if (/claude[- ]?code/i.test(prompt)) return "Claude Code"
    if (/cursor/i.test(prompt)) return "Cursor"
  } catch {
    // Ignore non-stringifiable values
  }
  return undefined
}

function matchSdkAgent(ua: string): string | undefined {
  if (/ai-sdk/i.test(ua)) {
    if (/ai-sdk-openai-compatible/i.test(ua) && /node\.js/i.test(ua)) {
      return "OpenCode"
    }
    return "AI SDK"
  }
  if (
    /@anthropic-ai\/sdk|anthropic-python|anthropic-node|anthropic-typescript/i.test(
      ua,
    )
  ) {
    return "Anthropic SDK"
  }
  if (
    /openai-python|openai-node|openai-typescript|openai-js|OpenAI\/Python|OpenAI\/Node|^openai\//i.test(
      ua,
    )
  ) {
    return "OpenAI SDK"
  }
  if (/\bopenai\b/i.test(ua)) return "OpenAI SDK"
  if (/\banthropic\b/i.test(ua)) return "Anthropic SDK"
  return undefined
}

function matchFallback(ua: string): string {
  const match = ua.match(/^([A-Za-z0-9_-]+)(?:\/[0-9.]+)?/)
  if (
    match?.[1]
    && !["mozilla", "http", "node", "undici"].includes(match[1].toLowerCase())
  ) {
    return normalizeClientName(match[1])
  }
  return "Unknown client"
}

/**
 * Heuristically inspects request headers, User-Agent string, and payload
 * to infer the authoritative client/agent display name.
 */
export function inferClientAgent(
  c: Context | undefined,
  payload?: unknown,
): string {
  const fromHeader = matchHeaderAgent(c)
  if (fromHeader) return fromHeader

  const ua = c?.req.header("user-agent") ?? ""

  const fromUa = matchUserAgent(ua)
  if (fromUa) return fromUa

  const fromPayload = matchPayloadAgent(payload)
  if (fromPayload) return fromPayload

  const fromSdk = matchSdkAgent(ua)
  if (fromSdk) return fromSdk

  return matchFallback(ua)
}
