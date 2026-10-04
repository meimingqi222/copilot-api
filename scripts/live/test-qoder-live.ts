/**
 * Qoder 真实连通性冒烟（**不进 CI**，需要真实的 Qoder 订阅账号）。
 *
 * 用法：
 *   bun run scripts/live/test-qoder-live.ts
 *
 * 流程：设备流登录 → 拉模型列表 → 非流式 + 流式各发一条 → 读用量。
 * 私有接口（api3.qoder.sh）是逆向产物，真实可用性依赖这个脚本。
 */

import type { ProviderConnection } from "~/lib/provider-connections/types"

import { fetchQoderQuota } from "~/lib/quota/fetchers/qoder"
import { qoderNativeAdapter } from "~/services/protocols/qoder-native"
import { QODER_API_HOST, qoderChatUrl } from "~/services/qoder/endpoints"
import {
  parseQoderModelList,
  qoderModelMappings,
} from "~/services/qoder/models"
import {
  createQoderAuthRequest,
  exchangeQoderJobToken,
  fetchQoderUserInfo,
  pollQoderDeviceToken,
  qoderJobTokenLifetimeMs,
} from "~/services/oauth/qoder"

function log(step: string, value: unknown): void {
  console.log(`\n== ${step} ==`)
  console.log(value)
}

async function main(): Promise<void> {
  // ── 1. 设备流登录 ────────────────────────────────────────────────
  const request = createQoderAuthRequest()
  log("在浏览器打开这个地址并确认授权", request.authUrl)
  const device = await pollQoderDeviceToken({
    nonce: request.nonce,
    verifier: request.pkce.codeVerifier,
    intervalMs: 2000,
  })
  log("设备 token", `${device.token.slice(0, 12)}… (uid=${device.userId})`)

  const job = await exchangeQoderJobToken(device.token)
  log("job token", `${job.token.slice(0, 12)}… expiresIn=${job.expiresInMs}`)

  const info = await fetchQoderUserInfo(device.token).catch(() => undefined)
  log("账号信息", info ?? "(userinfo 读取失败，仅影响展示)")

  // ── 2. 组装一个内存里的 connection（与登录落库的形状一致）────────
  const now = Date.now()
  const connection: ProviderConnection = {
    id: "qoder-live",
    name: "Qoder (live)",
    protocol: "qoder-native",
    baseUrl: QODER_API_HOST,
    enabled: true,
    priority: 0,
    credentials: [
      {
        id: "qoder-live-cred",
        authMode: "bearer",
        value: job.token,
        enabled: true,
        status: "ready",
        context: {
          refreshToken: job.refreshToken,
          deviceToken: device.token,
          deviceRefreshToken: device.refreshToken,
          uid: device.userId || info?.id || "",
          machineId: request.machineId,
          name: info?.name,
          email: info?.email,
          expiresAt: now + qoderJobTokenLifetimeMs(job),
        },
        createdAt: now,
      },
    ],
    models: [],
    createdAt: now,
  }

  // ── 3. 模型发现 ──────────────────────────────────────────────────
  const models = await qoderNativeAdapter.discoverModels?.({
    connection,
    credential: connection.credentials[0]!,
  })
  log(
    "模型列表",
    models?.map((m) => m.publicId),
  )
  const first = models?.[0]
  if (!first) throw new Error("没有发现任何启用模型")
  connection.models = qoderModelMappings(
    parseQoderModelList({ chat: [first.metadata?.qoderModelConfig] }),
  )

  const target = {
    connectionId: connection.id,
    connectionName: connection.name,
    protocol: "qoder-native" as const,
    credentialId: connection.credentials[0]!.id,
    publicModelId: first.publicId,
    upstreamModelId: first.upstreamId,
    endpoint: "chat" as const,
    connectionPriority: 0,
    connectionWeight: 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }

  // ── 4. 非流式 ────────────────────────────────────────────────────
  const nonStream = await qoderNativeAdapter.createChatCompletions?.({
    target,
    connection,
    credential: connection.credentials[0]!,
    payload: {
      model: first.publicId,
      messages: [{ role: "user", content: "只回复两个字：连通" }],
    },
  })
  log(
    "非流式响应",
    JSON.stringify(nonStream?.response, undefined, 2).slice(0, 2000),
  )

  // ── 5. 流式（含一个工具，验证 XML/原生 tool_calls 与 finish_reason）─
  const streamed = await qoderNativeAdapter.createChatCompletions?.({
    target,
    connection,
    credential: connection.credentials[0]!,
    payload: {
      model: first.publicId,
      stream: true,
      messages: [{ role: "user", content: "现在几点？请调用 get_time。" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_time",
            description: "读取当前时间",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
  })
  const chunks: Array<string> = []
  for await (const event of streamed!.response as AsyncIterable<{
    data?: string
  }>) {
    if (event.data) chunks.push(event.data)
  }
  log("流式帧数", chunks.length)
  log("流式尾部", chunks.slice(-6))
  if (chunks.some((c) => c.includes("tool_calls"))) {
    log("工具调用", "检测到 tool_calls 帧 ✓")
  }
  log("Qoder SSE 端点", qoderChatUrl())

  // ── 6. 用量 ──────────────────────────────────────────────────────
  const quota = await fetchQoderQuota(connection)
  log("用量快照", JSON.stringify(quota, undefined, 2))
}

await main()
