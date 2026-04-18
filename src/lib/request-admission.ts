import type { Context } from "hono"

import consola from "consola"

import type { Account } from "~/lib/accounts"
import type { ProtectedRouteKind } from "~/lib/protected-routes"

import { getAccountForModel } from "~/lib/account-selection"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
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
  messageContent?: string
}

export async function prepareRequestAdmission(
  c: Context,
  options: PrepareRequestAdmissionOptions,
): Promise<RequestAdmission> {
  c.set("model" as never, options.model)

  try {
    checkProtectedRouteGuard(c, {
      routeKind: options.routeKind,
      model: options.model,
      maxTokens: options.maxTokens,
      stream: options.stream,
      messageContent: options.messageContent,
    })
  } catch (error) {
    if (error instanceof Error) {
      consola.warn(
        `Request admission failed before account selection: ${JSON.stringify({
          path: c.req.path,
          model: options.model,
          routeKind: options.routeKind,
          maxTokens: options.maxTokens,
          stream: options.stream ?? false,
          errorName: error.name,
          errorMessage: error.message,
        })}`,
      )
    }
    throw error
  }

  let account: Account
  try {
    account = getAccountForModel(options.model)
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.warn(
        `Request admission failed during account selection: ${JSON.stringify({
          path: c.req.path,
          model: options.model,
          routeKind: options.routeKind,
          maxTokens: options.maxTokens,
          stream: options.stream ?? false,
          status: error.response.status,
          retryAfter: error.response.headers.get("Retry-After"),
          message: error.message,
        })}`,
      )
    }
    throw error
  }
  const { initiator } = resolveInitiatorWithClientHeader(
    c,
    options.inferredInitiator ?? "user",
  )

  c.set("guardInitiator" as never, initiator)

  if (state.manualApprove) {
    await awaitApproval()
  }

  return { account, initiator }
}
