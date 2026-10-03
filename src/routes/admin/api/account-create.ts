import { Hono } from "hono"

import type { ManagedConnectionInput } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { isProviderId, type ProviderId } from "~/lib/provider-config"
import {
  getProviderConnection,
  listAccountManagedConnections,
  managedConnectionFromInput,
  persistProviderConnections,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { readBinaryBody, readJsonBody } from "~/lib/request-body"
import { refreshModelsForConnection } from "~/lib/utils"
import { parseLobsteraiClientDatabase } from "~/services/lobsterai/parse-client-db"
import { initializeProviderRegistry } from "~/services/providers"
import { getBuiltinProviderModule } from "~/services/providers/builtins"
import type { CreateAccountBody } from "~/services/providers/account-creation/types"

import { publicAccountFromConnection } from "./account-views"
import { registerPendingFlow } from "./device-flow"

/**
 * 落库新建的 account-managed connection:写入内存、刷新模型、持久化,
 * 返回 admin API 的账户视图。刷新失败时 models 保持为空但不阻断创建
 * (与其他 provider 的 init 失败语义一致:仅 warn)。
 */
async function finalizeCreatedConnection(
  input: ManagedConnectionInput,
): Promise<{ accountId: string; account: unknown }> {
  const conn = managedConnectionFromInput(input)
  upsertProviderConnection(conn)
  await refreshModelsForConnection(conn)
  await persistProviderConnections()
  return {
    accountId: conn.id,
    account: publicAccountFromConnection(
      getProviderConnection(conn.id) ?? conn,
    ),
  }
}

export const createAccountRoutes = new Hono()

/** 上传的客户端数据库体积上限（实测约 280 KB，留足冗余）。 */
const MAX_LOBSTERAI_DB_BYTES = 64 * 1024 * 1024

/**
 * 解析上传的 LobsterAI 客户端数据库，返回提取到的凭证供前端填表。
 *
 * 只解析、不落库：前端拿到字段后仍走正常的创建流程。
 * 之所以要传到服务端解析，是因为 copilot-api 常部署在远端，
 * 读不到用户本机的 `lobsterai.sqlite`。
 */
createAccountRoutes.post("/parse-lobsterai-db", async (c) => {
  let bytes: Uint8Array
  try {
    bytes = await readBinaryBody(c.req.raw, MAX_LOBSTERAI_DB_BYTES)
  } catch (error) {
    if (error instanceof HTTPError) {
      return c.json({ error: error.message }, 413)
    }
    return c.json({ error: "Failed to read uploaded file." }, 400)
  }

  try {
    const parsed = await parseLobsteraiClientDatabase(bytes)
    return c.json({
      ok: true,
      credentials: {
        accessToken: parsed.accessToken,
        ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
        ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
        ...(parsed.uid ? { userId: parsed.uid } : {}),
        ...(parsed.uuid ? { uuid: parsed.uuid } : {}),
        ...(parsed.firstKeyfrom ? { firstKeyfrom: parsed.firstKeyfrom } : {}),
        ...(parsed.latestKeyfrom ?
          { latestKeyfrom: parsed.latestKeyfrom }
        : {}),
      },
      profile: {
        ...(parsed.nickname ? { nickname: parsed.nickname } : {}),
        ...(parsed.yid ? { yid: parsed.yid } : {}),
        ...(parsed.uid ? { userId: parsed.uid } : {}),
      },
    })
  } catch (error) {
    logger.warn(
      "Failed to parse uploaded LobsterAI database:",
      error instanceof Error ? error.message : error,
    )
    return c.json(
      {
        error:
          error instanceof Error ?
            error.message
          : "Failed to parse LobsterAI database.",
      },
      400,
    )
  }
})

createAccountRoutes.post("/", async (c) => {
  initializeProviderRegistry()
  let body: CreateAccountBody
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const provider: ProviderId =
    body.provider && isProviderId(body.provider) ? body.provider : "copilot"
  const label =
    body.label ?? `account-${listAccountManagedConnections().length + 1}`

  // Provider 准备凭证（或注册设备码 flow），宿主负责落库与账户视图。
  const module = getBuiltinProviderModule(provider)
  const creation = module?.accountCreation
  if (!creation) {
    return c.json({ error: `Unsupported account provider: ${provider}` }, 400)
  }

  const result = await creation.prepare({
    body,
    label,
    registerDeviceFlow(flow, flowLabel) {
      registerPendingFlow(flow.device_code, {
        label: flowLabel,
        provider,
        interval: flow.interval,
        expiresAt: Date.now() + flow.expires_in * 1000,
        status: "pending",
      })

      // Clean up expired flows after expiry
      setTimeout(async () => {
        const { getPendingFlow, savePendingFlows } = await import(
          "./device-flow"
        )
        const pending = getPendingFlow(flow.device_code)
        if (pending && pending.status === "pending") {
          pending.status = "expired"
          await savePendingFlows()
        }
        setTimeout(async () => {
          const { removePendingFlow, savePendingFlows: save } = await import(
            "./device-flow"
          )
          removePendingFlow(flow.device_code)
          await save()
        }, 60_000)
      }, flow.expires_in * 1000)
    },
  })

  if ("error" in result) {
    return c.json({ error: result.error }, result.status ?? 400)
  }
  if ("response" in result) {
    return c.json(result.response)
  }

  const finalized = await finalizeCreatedConnection(result)
  const conn = getProviderConnection(result.id)
  if (conn) await module?.afterAuthentication?.(conn)
  return c.json({ status: "complete", ...finalized })
})
