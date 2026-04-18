import type { Context } from "hono"

import type { Account } from "~/lib/accounts"
import type { ProtectedRouteKind } from "~/lib/protected-routes"

import { getAccountForModel } from "~/lib/account-selection"
import { awaitApproval } from "~/lib/approval"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkProtectedRouteGuard } from "~/lib/protected-route-guard"
import { state } from "~/lib/state"

export interface RequestAdmission {
  account: Account
  initiator?: "agent" | "user"
}

interface PrepareRequestAdmissionOptions {
  routeKind?: ProtectedRouteKind
  model: string
  maxTokens?: number
  stream?: boolean
  inferredInitiator?: "agent" | "user"
}

export async function prepareRequestAdmission(
  c: Context,
  options: PrepareRequestAdmissionOptions,
): Promise<RequestAdmission> {
  checkProtectedRouteGuard(c, {
    routeKind: options.routeKind,
    model: options.model,
    maxTokens: options.maxTokens,
    stream: options.stream,
  })

  const account = getAccountForModel(options.model)
  const { initiator } = resolveInitiatorWithClientHeader(
    c,
    options.inferredInitiator ?? "user",
  )

  c.set("guardInitiator" as never, initiator)
  c.set("model" as never, options.model)

  if (state.manualApprove) {
    await awaitApproval()
  }

  return { account, initiator }
}
