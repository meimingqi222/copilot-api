import type { Context } from "hono"

export type CopilotInitiator = "agent" | "user"

function normalizeInitiator(
  value: string | undefined,
): CopilotInitiator | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "agent" || normalized === "user") {
    return normalized
  }
  return undefined
}

export function resolveInitiatorWithClientHeader(
  c: Context,
  inferredInitiator: CopilotInitiator,
): {
  clientInitiator: CopilotInitiator | undefined
  initiator: CopilotInitiator
  trustedClientAgent: boolean
} {
  const clientInitiator = normalizeInitiator(c.req.header("x-initiator"))
  const { initiator, trustedClientAgent } = resolveInitiatorFromHeader(
    clientInitiator,
    inferredInitiator,
  )

  return {
    clientInitiator,
    initiator,
    trustedClientAgent,
  }
}

export function resolveInitiatorFromHeader(
  clientInitiator: CopilotInitiator | undefined,
  inferredInitiator: CopilotInitiator,
): {
  initiator: CopilotInitiator
  trustedClientAgent: boolean
} {
  const trustedClientAgent = clientInitiator === "agent"
  const initiator = trustedClientAgent ? "agent" : inferredInitiator
  return { initiator, trustedClientAgent }
}
