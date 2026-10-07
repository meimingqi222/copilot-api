import { HTTPError } from "~/lib/error"
import type {
  AnthropicMessagesPayload,
  AnthropicServerTool,
} from "~/services/protocols/anthropic/types"
import type { ToolPermission } from "~/services/claude/cli/controls"
import { bridgeTools } from "~/services/claude/cli/tools"
import { mcpToolNamePrefix } from "~/services/claude/cli/mcp-names"

export function claudeSearchDeclaration(
  payload: AnthropicMessagesPayload,
): AnthropicServerTool | undefined {
  if (payload.tool_choice?.type === "none") return undefined
  return payload.tools?.find(
    (tool): tool is AnthropicServerTool =>
      !("input_schema" in tool)
      && tool.type.startsWith("web_search")
      && (payload.tool_choice?.type !== "tool"
        || payload.tool_choice.name === tool.name),
  )
}
function invalid(message: string): never {
  throw new HTTPError(message, new Response(message, { status: 400 }))
}
function domains(value: Array<string> | undefined): Array<string> | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value)
    || value.some(
      (domain) =>
        typeof domain !== "string"
        || !/^[\p{L}\p{N}.-]+$/u.test(domain)
        || domain.includes(".."),
    )
  )
    invalid("Search domains must be hostnames")
  if (!value.length) return undefined
  try {
    return [
      ...new Set(
        value.map((domain) => {
          const hostname = new URL(`https://${domain}`).hostname
            .toLowerCase()
            .replace(/\.$/, "")
          if (
            !hostname
            || hostname
              .split(".")
              .some(
                (label) =>
                  !label || label.startsWith("-") || label.endsWith("-"),
              )
          )
            invalid("Search domains must be hostnames")
          return hostname
        }),
      ),
    ]
  } catch {
    return invalid("Search domains must be hostnames")
  }
}

/** The caller's constraints override model-supplied native search inputs. */
export class ClaudeSearchPolicy {
  private uses = 0
  private readonly search: AnthropicServerTool | undefined
  private readonly allowed: Array<string> | undefined
  private readonly blocked: Array<string> | undefined
  private readonly tools: Set<string>
  private readonly payload: AnthropicMessagesPayload
  constructor(payload: AnthropicMessagesPayload) {
    this.payload = payload
    this.search = claudeSearchDeclaration(payload)
    this.allowed = domains(this.search?.allowed_domains)
    this.blocked = domains(this.search?.blocked_domains)
    if (this.allowed && this.blocked)
      invalid("Specify allowed_domains or blocked_domains, not both")
    const max = this.search?.max_uses
    if (max !== undefined && (!Number.isSafeInteger(max) || max < 0))
      invalid("Search max_uses must be a non-negative integer")
    this.tools = new Set(
      bridgeTools(payload).map((tool) => `${mcpToolNamePrefix()}${tool.name}`),
    )
  }
  permission(name: string, input: Record<string, unknown>): ToolPermission {
    if (name !== "WebSearch") {
      if (
        this.tools.has(name)
        || (name === "StructuredOutput" && this.payload.output_config?.format)
      )
        return { behavior: "allow", updatedInput: input }
      return {
        behavior: "deny",
        message: "This tool is not declared by the caller",
      }
    }
    if (!this.search)
      return {
        behavior: "deny",
        message: "Web search is not enabled by the caller",
      }
    if (this.search.max_uses !== undefined && this.uses >= this.search.max_uses)
      return {
        behavior: "deny",
        message: "The caller's web search max_uses has been reached",
      }
    this.uses++
    const {
      allowed_domains: _allowed,
      blocked_domains: _blocked,
      ...rest
    } = input
    return {
      behavior: "allow",
      updatedInput: {
        ...rest,
        ...(this.allowed && { allowed_domains: this.allowed }),
        ...(this.blocked && { blocked_domains: this.blocked }),
      },
    }
  }
}
