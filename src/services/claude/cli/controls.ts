import { randomUUID } from "node:crypto"
import { ClaudeCliError } from "~/services/claude/cli/errors"

export type ToolPermission =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
type Pending = { resolve: () => void; reject: (error: Error) => void }
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

/** SDK control messages share stdout/stdin with the conversation. */
export class ClaudeCliControls {
  private readonly pending = new Map<string, Pending>()
  private readonly replies = new Map<string, unknown>()
  private readonly write: (value: unknown) => void
  private readonly permission: (
    name: string,
    input: Record<string, unknown>,
  ) => ToolPermission
  constructor(
    write: (value: unknown) => void,
    permission: (
      name: string,
      input: Record<string, unknown>,
    ) => ToolPermission,
  ) {
    this.write = write
    this.permission = permission
  }

  applyEffort(
    effort: string,
    signal?: AbortSignal,
    timeoutMs = 5000,
  ): Promise<void> {
    signal?.throwIfAborted()
    const id = `effort-${randomUUID()}`
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        this.pending.delete(id)
        if (error) reject(error)
        else resolve()
      }
      const abort = () =>
        finish(
          signal?.reason instanceof Error ?
            signal.reason
          : new ClaudeCliError("Claude CLI control request cancelled"),
        )
      const timer = setTimeout(
        () =>
          finish(
            new ClaudeCliError(
              "Claude CLI did not acknowledge the effort update",
            ),
          ),
        timeoutMs,
      )
      timer.unref?.()
      this.pending.set(id, { resolve: () => finish(), reject: finish })
      signal?.addEventListener("abort", abort, { once: true })
      try {
        this.write({
          type: "control_request",
          request_id: id,
          request: {
            subtype: "apply_flag_settings",
            settings: { effortLevel: effort },
          },
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  handle(value: unknown): boolean {
    const envelope = object(value)
    if (envelope?.type === "control_response") {
      const response = object(envelope.response)
      if (typeof response?.request_id !== "string") return true
      const waiting = this.pending.get(response.request_id)
      if (response.subtype === "success") waiting?.resolve()
      else
        waiting?.reject(
          new ClaudeCliError(
            typeof response.error === "string" ?
              response.error
            : "Claude CLI rejected the effort update",
          ),
        )
      return true
    }
    if (envelope?.type !== "control_request") return false
    const request = object(envelope.request)
    if (typeof envelope.request_id !== "string") return true
    const previous = this.replies.get(envelope.request_id)
    if (previous) {
      this.write(previous)
      return true
    }
    const input = object(request?.input)
    const response =
      (
        request?.subtype === "can_use_tool"
        && typeof request.tool_name === "string"
        && input
      ) ?
        this.permission(request.tool_name, input)
      : {
          behavior: "deny",
          message: "Unsupported Claude CLI permission request",
        }
    const reply = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: envelope.request_id,
        response,
      },
    }
    this.replies.set(envelope.request_id, reply)
    if (this.replies.size > 128)
      this.replies.delete(this.replies.keys().next().value!)
    this.write(reply)
    return true
  }

  close(): void {
    this.replies.clear()
    for (const pending of this.pending.values())
      pending.reject(
        new ClaudeCliError("Claude CLI ended during a control request"),
      )
  }
}
