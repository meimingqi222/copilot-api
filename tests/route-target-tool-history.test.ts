/**
 * 带工具调用的请求不得路由到"会话状态绑定"的后端（LobsterAI 的 deepseek 系）。
 *
 * 该后端只认自己签发过的 tool_call id：历史里回放别家签发的 id 直接 500；而把
 * 工具历史摊平成文本又会让模型学会 "[tool_call ...]" 这种假约定，把工具调用写成
 * 文本（实测 Hermes 会话经该后端后丢结构化 tool_calls）。所以这类请求改走能原生
 * 支持结构化工具调用的 provider。
 */
import { describe, expect, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections/types"

import { buildRouteTargets } from "~/lib/route-target/build"

function lobsterConnection(id: string, upstreamId: string): ProviderConnection {
  const credential: ApiCredential = {
    id: id + "-cred",
    authMode: "bearer",
    value: "x",
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
  }
  return {
    id,
    name: id,
    protocol: "lobsterai-native",
    baseUrl: "https://lobsterai-server.youdao.com",
    enabled: true,
    priority: 0,
    credentials: [credential],
    models: [
      {
        publicId: upstreamId,
        upstreamId,
        name: upstreamId,
        endpoints: ["chat"],
        enabled: true,
        pickerEnabled: true,
      },
    ],
    createdAt: Date.now(),
  } as unknown as ProviderConnection
}

const connections = [
  lobsterConnection("lobster-deepseek", "deepseek-flash"),
  lobsterConnection("lobster-glm", "glm-5.3-flashx"),
]

const names = (withGate: boolean, connectionId?: string) =>
  buildRouteTargets({
    endpoint: "chat",
    connections,
    ...(withGate ? { requireStructuredTools: true } : {}),
    ...(connectionId ? { connectionId } : {}),
  })
    .map((target) => target.connectionName)
    .sort()

describe("buildRouteTargets: 工具请求跳过会话状态绑定的后端", () => {
  test("默认保留 deepseek 与 glm 两个候选", () => {
    expect(names(false)).toEqual(["lobster-deepseek", "lobster-glm"])
  })

  test("requireStructuredTools 过滤掉 deepseek target，保留 glm", () => {
    expect(names(true)).toEqual(["lobster-glm"])
  })

  test("显式 pin 了 connectionId 时不参与过滤（尊重显式意图）", () => {
    expect(names(true, "lobster-deepseek")).toEqual(["lobster-deepseek"])
  })
})
