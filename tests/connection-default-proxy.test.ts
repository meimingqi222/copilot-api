/**
 * 系统设置"默认代理 URL"的回归测试。
 *
 * 背景：连接级 `proxyUrl` 只在连接自己填了才有值，于是每接一个新账号都要手工
 * 配一次代理。系统设置里新增 `defaultProxyUrl` 后，`getConnectionProxyUrl`
 * 在连接自身没配时回退到它 —— 这里锁住优先级：连接级 > metadata > 系统默认 >
 * 无，并明确空串等同未配置。
 */
import { beforeEach, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"
import { getConnectionProxyUrl } from "~/lib/provider-connections"
import {
  getSystemSettings,
  initializeSystemConfig,
  updateSystemConfig,
} from "~/lib/system-config"

const DEFAULT_PROXY = "http://127.0.0.1:18090"
const CONNECTION_PROXY = "http://proxy.example.invalid:8080"

function initialize(): void {
  initializeSystemConfig({
    save: () => undefined,
    onChange: () => undefined,
  })
}

function setDefaultProxy(url: string): void {
  updateSystemConfig({
    ...getSystemSettings(),
    debugMinutes: 15,
    defaultProxyUrl: url,
  })
}

function makeConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "conn-1",
    name: "conn-1",
    protocol: "openai-compatible",
    baseUrl: "https://upstream.test/v1",
    enabled: true,
    priority: 0,
    credentials: [],
    createdAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  initialize()
  setDefaultProxy("")
})

test("a connection-level proxy wins over the system default", () => {
  setDefaultProxy(DEFAULT_PROXY)
  expect(
    getConnectionProxyUrl(makeConnection({ proxyUrl: CONNECTION_PROXY })),
  ).toBe(CONNECTION_PROXY)
})

test("metadata.proxyUrl is used when the typed field is absent", () => {
  setDefaultProxy(DEFAULT_PROXY)
  const conn = makeConnection()
  // 故意不带 metadata.provider：代理是传输层字段，不该被 provider 派生拦掉
  // （anthropic-compatible 的账号连接 metadata 就只有 proxyUrl/settings）。
  conn.metadata = {
    proxyUrl: CONNECTION_PROXY,
  } as unknown as ProviderConnection["metadata"]
  expect(getConnectionProxyUrl(conn)).toBe(CONNECTION_PROXY)
})

test("metadata.settings.proxyUrl is honoured when the top-level field is absent", () => {
  setDefaultProxy(DEFAULT_PROXY)
  const conn = makeConnection()
  conn.metadata = {
    settings: { proxyUrl: CONNECTION_PROXY },
  } as unknown as ProviderConnection["metadata"]
  expect(getConnectionProxyUrl(conn)).toBe(CONNECTION_PROXY)
})

test("a connection without any proxy falls back to the system default", () => {
  setDefaultProxy(DEFAULT_PROXY)
  expect(getConnectionProxyUrl(makeConnection())).toBe(DEFAULT_PROXY)
})

test("an empty system default means no proxy at all", () => {
  setDefaultProxy("")
  expect(getConnectionProxyUrl(makeConnection())).toBeUndefined()
})

test("an emptied connection proxy falls back to the default", () => {
  // 空串是"清除"语义（PUT 路由与原 UI 都这么做），所以它等同未配置。
  setDefaultProxy(DEFAULT_PROXY)
  const conn = makeConnection({ proxyUrl: "" })
  conn.metadata = { proxyUrl: "" } as unknown as ProviderConnection["metadata"]
  expect(getConnectionProxyUrl(conn)).toBe(DEFAULT_PROXY)
})
